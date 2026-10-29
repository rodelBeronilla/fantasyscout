from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import httpx
import pyarrow as pa
import pytest

from export import build as build_mod
from export.encode import rows_of, sha256, to_json, to_parquet
from export.source import DatabricksSource, DuckDBSource
from export.store import LocalStore, R2Store, content_type_for

DBT_DB = Path(__file__).resolve().parent.parent / "dbt" / "fantasyscout.duckdb"


# ---- encoding ------------------------------------------------------------------------------


def test_json_is_compact_and_browser_safe() -> None:
    table = pa.table(
        {
            "d": [date(2026, 9, 24)],
            "ts": [datetime(2026, 10, 27, 9, 15, tzinfo=UTC)],
            "x": [float("nan")],
            "m": [Decimal("1.50")],
        }
    )
    rows = rows_of(table)
    assert rows == [{"d": "2026-09-24", "ts": "2026-10-27T09:15:00+00:00", "x": None, "m": 1.5}]
    assert (
        to_json(rows) == b'[{"d":"2026-09-24","ts":"2026-10-27T09:15:00+00:00","x":null,"m":1.5}]'
    )


def test_parquet_round_trips_and_is_deterministic() -> None:
    import pyarrow.parquet as pq

    table = pa.table({"league": ["wnba", "wnba"], "n": [1, 2]})
    body = to_parquet(table)
    assert pq.read_table(pa.BufferReader(body)).equals(table)
    assert sha256(body) == sha256(to_parquet(table))


def test_content_types() -> None:
    assert content_type_for("builds/x/health.json") == "application/json"
    assert content_type_for("a/b.parquet") == "application/vnd.apache.parquet"
    assert content_type_for("keys.txt").startswith("text/plain")


# ---- store ---------------------------------------------------------------------------------


def test_local_store_round_trip(tmp_path: Path) -> None:
    store = LocalStore(tmp_path)
    assert store.get("latest.json") is None
    store.put("builds/b1/x.json", b"{}")
    assert store.get("builds/b1/x.json") == b"{}"
    store.delete("builds/b1/x.json")
    store.delete("builds/b1/x.json")  # idempotent
    assert store.get("builds/b1/x.json") is None


def test_r2_store_uses_the_object_endpoint_and_retries() -> None:
    calls: list[tuple[str, str, str | None]] = []
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        calls.append((request.method, request.url.path, request.headers.get("content-type")))
        if request.method == "PUT":
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, headers={"retry-after": "0"})
            return httpx.Response(200, json={"success": True})
        if request.method == "GET":
            return (
                httpx.Response(404)
                if "missing" in request.url.path
                else httpx.Response(200, content=b"body")
            )
        return httpx.Response(204)

    import export.store as store_mod

    store = R2Store("acct", "tok", transport=httpx.MockTransport(handler), sleep=0.0)
    store_mod.time.sleep = lambda _: None  # type: ignore[assignment]
    store.put("builds/b1/health.json", b"{}")
    assert store.get("latest.json") == b"body"
    assert store.get("missing.json") is None
    store.delete("builds/b1/health.json")
    assert (
        calls[0][1]
        == "/client/v4/accounts/acct/r2/buckets/fantasyscout-data/objects/builds/b1/health.json"
    )
    assert calls[0][2] == "application/json"
    assert [c[0] for c in calls] == ["PUT", "PUT", "GET", "GET", "DELETE"]
    assert store.requests == 5
    store.close()


def test_r2_store_retries_a_dropped_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    import export.store as store_mod

    monkeypatch.setattr(store_mod.time, "sleep", lambda _: None)
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return httpx.Response(200, json={"success": True})

    store = R2Store("acct", "tok", transport=httpx.MockTransport(handler), sleep=0.0)
    store.put("builds/b1/manifest.json", b"{}")
    assert attempts == 3
    store.close()


def test_r2_store_raises_when_the_connection_keeps_dropping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import export.store as store_mod

    monkeypatch.setattr(store_mod.time, "sleep", lambda _: None)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unreachable")

    store = R2Store("acct", "tok", transport=httpx.MockTransport(handler), sleep=0.0)
    with pytest.raises(httpx.ConnectError):
        store.put("builds/b1/manifest.json", b"{}")
    assert store.requests == store_mod._RETRIES + 1
    store.close()


# ---- publish, prune, rollback (no warehouse needed) -----------------------------------------


def fake_build(build_id: str, n: int = 2) -> build_mod.Build:
    b = build_mod.Build(
        build_id=build_id,
        engine="duckdb",
        git_sha="abc1234",
        created_at="2026-10-27T09:00:00+00:00",
    )
    for i in range(n):
        b.files[f"t{i}.json"] = b"[]"
    b.manifest = {"build_id": build_id, "data_as_of": {"wnba": "2026-09-24"}, "files": {}}
    return b


def test_publish_flips_latest_last_and_prunes_beyond_keep(tmp_path: Path) -> None:
    store = LocalStore(tmp_path)
    log: list[str] = []
    for i in range(4):
        build_mod.publish(store, fake_build(f"b{i}"), keep=2, log=log.append)
    latest = json.loads(store.get("latest.json") or b"{}")
    builds = json.loads(store.get("builds.json") or b"[]")
    assert latest["build_id"] == "b3"
    assert [b["build_id"] for b in builds] == ["b3", "b2"]
    assert store.get("builds/b1/manifest.json") is None, "pruned build is gone"
    assert store.get("builds/b1/keys.txt") is None
    assert store.get("builds/b3/t0.json") == b"[]"
    assert store.get("builds/b2/manifest.json") is not None
    assert any("pruned b1" in line for line in log)


def test_a_staged_build_goes_live_only_when_promoted(tmp_path: Path) -> None:
    """#96 item 3: notebooks and the extract are added before latest.json points at the build."""
    store = LocalStore(tmp_path)
    build_mod.publish(store, fake_build("b0"), log=lambda _: None)
    build_mod.stage(store, fake_build("b1"), log=lambda _: None)
    assert json.loads(store.get("latest.json") or b"{}")["build_id"] == "b0"
    assert [b["build_id"] for b in json.loads(store.get("builds.json") or b"[]")] == ["b0"]
    extra = tmp_path / "findings.json"
    extra.write_text("{}", encoding="utf-8")
    build_mod.publish_files(store, [extra], subdir="notebooks", build_id="b1", log=lambda _: None)
    latest = build_mod.promote(store, "b1", log=lambda _: None)
    assert latest["build_id"] == "b1"
    assert json.loads(store.get("latest.json") or b"{}")["build_id"] == "b1"
    assert [b["build_id"] for b in json.loads(store.get("builds.json") or b"[]")] == ["b1", "b0"]
    assert store.get("builds/b1/notebooks/findings.json") == b"{}"
    with pytest.raises(RuntimeError, match="not staged"):
        build_mod.promote(store, "nope", log=lambda _: None)


def test_rollback_points_at_the_previous_build_and_prune_keeps_it(tmp_path: Path) -> None:
    store = LocalStore(tmp_path)
    for i in range(3):
        build_mod.publish(store, fake_build(f"b{i}"), keep=3, log=lambda _: None)
    pointer = build_mod.rollback(store, log=lambda _: None)
    assert pointer["build_id"] == "b1" and pointer["rolled_back_from"] == "b2"
    pointer = build_mod.rollback(store, to="b0", log=lambda _: None)
    assert pointer["build_id"] == "b0"
    # A new publish with keep=1 keeps the newest and the one latest points at.
    build_mod.publish(store, fake_build("b3"), keep=1, log=lambda _: None)
    builds = [b["build_id"] for b in json.loads(store.get("builds.json") or b"[]")]
    assert builds == ["b3"], "publishing moves latest forward again"
    with pytest.raises(RuntimeError, match=r"not in builds\.json"):
        build_mod.rollback(store, to="nope", log=lambda _: None)


# ---- a real build from the dbt sample (CI builds it first) ------------------------------------


@pytest.mark.skipif(not DBT_DB.exists(), reason="dbt sample not built")
def test_assemble_from_the_dbt_sample(tmp_path: Path) -> None:
    source = DuckDBSource(DBT_DB)
    try:
        build = build_mod.assemble(
            source, engine="duckdb", git_sha="abc1234", build_id="t1", log=lambda _: None
        )
    finally:
        source.close()
    manifest = build.manifest
    assert manifest["build_id"] == "t1"
    assert "gold.fct_player_game" in manifest["tables"]
    assert any(p.startswith("fct_player_game/wnba-") for p in manifest["files"])
    assert "board/wnba.json" in build.files and "health.json" in build.files
    players = [p for p in build.files if p.startswith("players/")]
    assert players and manifest["players"]["count"] == len(players)
    one = json.loads(build.files[players[0]])
    assert {"name", "seasons", "game_log", "shots", "shot_zones", "zscores"} <= set(one)
    health = json.loads(build.files["health.json"])
    assert (
        health["row_counts"]["gold.fct_player_game"]
        == manifest["tables"]["gold.fct_player_game"]["rows"]
    )
    latest = build_mod.publish(LocalStore(tmp_path), build, log=lambda _: None)
    assert latest["build_id"] == "t1"
    assert (tmp_path / "builds" / "t1" / "manifest.json").is_file()


# ---- the Databricks source --------------------------------------------------------------------


def test_databricks_source_follows_external_links() -> None:
    table = pa.table({"league": ["wnba"], "n": [1]})
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    ipc = sink.getvalue().to_pybytes()
    seen_auth: list[bool] = []

    def api(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "statement_id": "s1",
                    "status": {"state": "SUCCEEDED"},
                    "manifest": {"schema": {"columns": [{"name": "league"}, {"name": "n"}]}},
                    "result": {
                        "external_links": [
                            {
                                "chunk_index": 0,
                                "external_link": "https://links/0",
                                "next_chunk_index": 1,
                            }
                        ]
                    },
                },
            )
        return httpx.Response(
            200,
            json={"external_links": [{"chunk_index": 1, "external_link": "https://links/1"}]},
        )

    def links(request: httpx.Request) -> httpx.Response:
        seen_auth.append("authorization" in request.headers)
        return httpx.Response(200, content=ipc)

    source = DatabricksSource(
        "https://x",
        "t",
        "w",
        transport=httpx.MockTransport(api),
        link_transport=httpx.MockTransport(links),
        sleep=0.0,
    )
    out = source.query("select 1")
    source.close()
    assert out.num_rows == 2 and out.column_names == ["league", "n"]
    assert seen_auth == [False, False], "pre-signed links are fetched without the token"


def test_databricks_source_refuses_an_empty_warehouse() -> None:
    with pytest.raises(RuntimeError, match="warehouse_id"):
        DatabricksSource("https://x", "t", "")


def test_publish_files_attaches_them_to_the_latest_build(tmp_path: Path) -> None:
    store = LocalStore(tmp_path / "bucket")
    build_mod.publish(store, fake_build("b1"), log=lambda _: None)
    page = tmp_path / "01_shot_profiles.html"
    page.write_text("<html>hi</html>", encoding="utf-8")
    keys = build_mod.publish_files(store, [page], subdir="notebooks", log=lambda _: None)
    assert keys == ["builds/b1/notebooks/01_shot_profiles.html"]
    assert store.get("builds/b1/notebooks/01_shot_profiles.html") == b"<html>hi</html>"
    index = json.loads(store.get("builds/b1/notebooks/index.json") or b"{}")
    assert index == {"build_id": "b1", "files": ["01_shot_profiles.html"]}
    listing = (store.get("builds/b1/keys.txt") or b"").decode()
    assert "builds/b1/notebooks/01_shot_profiles.html" in listing, "pruning will remove them too"
    with pytest.raises(RuntimeError, match="no build"):
        build_mod.publish_files(
            LocalStore(tmp_path / "empty"), [page], subdir="notebooks", log=lambda _: None
        )


def test_rows_can_round_floats_for_compact_json() -> None:
    table = pa.table({"x": [1.234567891, None], "n": [3, 4]})
    assert rows_of(table, digits=4) == [{"x": 1.2346, "n": 3}, {"x": None, "n": 4}]
    assert rows_of(table)[0]["x"] == 1.234567891
