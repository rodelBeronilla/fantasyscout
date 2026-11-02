from __future__ import annotations

import json
import time
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import httpx
import pyarrow as pa
import pytest

from export import build as build_mod
from export import source as source_mod
from export.encode import rows_of, sha256, to_json, to_parquet
from export.source import DatabricksSource, DuckDBSource
from export.store import LocalStore, R2Store, content_type_for, delete_many

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


def test_r2_store_uses_the_object_endpoint_and_retries(monkeypatch: pytest.MonkeyPatch) -> None:
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

    store = R2Store("acct", "tok", transport=httpx.MockTransport(handler), sleep=0.0)
    monkeypatch.setattr(time, "sleep", lambda _: None)
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

    monkeypatch.setattr(time, "sleep", lambda _: None)
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

    monkeypatch.setattr(time, "sleep", lambda _: None)

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


def test_a_stage_that_never_goes_live_is_recorded_pruned_and_orphans_are_found(
    tmp_path: Path,
) -> None:
    """#404: a cut-short stage leaves a record, prune removes it after two days, orphans list."""
    store = LocalStore(tmp_path / "bucket")
    quiet = lambda _: None  # noqa: E731
    build_mod.publish(store, fake_build("b1"), log=quiet)
    assert json.loads(store.get("staging.json") or b"[]") == []  # promoted: off the record
    build_mod.stage(store, fake_build("b2"), log=quiet)  # the job dies before promote
    staging = json.loads(store.get("staging.json") or b"[]")
    assert [s["build_id"] for s in staging] == ["b2"]
    assert store.get("builds/b2/keys.txt"), "the key list is written first"
    # young: kept
    assert build_mod.prune_stale_stages(store, log=quiet) == []
    assert store.get("builds/b2/t0.json") is not None
    # three days later: removed, with every file its key list names
    later = datetime.now(UTC) + timedelta(days=3)
    assert build_mod.prune_stale_stages(store, now=later, log=quiet) == ["b2"]
    assert store.list("builds/b2/") == []
    assert json.loads(store.get("staging.json") or b"[]") == []
    # an orphan from before the records: a folder nothing names
    store.put("builds/b0/t0.json", b"[]")
    store.put("builds/b0/manifest.json", b"{}")
    assert build_mod.orphans(store) == ["b0"]
    build_mod.delete_orphan(store, "b0", log=quiet)
    assert build_mod.orphans(store) == [] and store.list("builds/b0/") == []
    assert store.get("builds/b1/manifest.json") is not None, "the live build is untouched"


def test_r2_store_lists_keys_across_pages() -> None:
    pages = {
        "": {
            "result": [{"key": "builds/b1/a.json"}],
            "result_info": {"cursor": "c2", "is_truncated": True},
        },
        "c2": {
            "result": [{"key": "builds/b2/b.json"}],
            "result_info": {"cursor": "", "is_truncated": False},
        },
    }
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/r2/buckets/fantasyscout-data/objects")
        assert request.url.params["prefix"] == "builds/"
        cursor = request.url.params.get("cursor", "")
        seen.append(cursor)
        return httpx.Response(200, json=pages[cursor])

    store = R2Store("acct", "token", transport=httpx.MockTransport(handler))
    assert store.list("builds/") == ["builds/b1/a.json", "builds/b2/b.json"]
    assert seen == ["", "c2"]


def test_r2_store_deletes_a_thousand_keys_per_request() -> None:
    """Pruning deletes in lists, not one request per file (#446)."""
    lists: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.url.path.endswith("/r2/buckets/fantasyscout-data/objects")
        keys = json.loads(request.content)
        lists.append(keys)
        return httpx.Response(200, json={"success": True, "result": [{"key": k} for k in keys]})

    store = R2Store("acct", "tok", transport=httpx.MockTransport(handler), sleep=0.0)
    keys = [f"builds/b1/f{i}.json" for i in range(2500)]
    assert delete_many(store, keys) == 2500
    assert [len(x) for x in lists] == [1000, 1000, 500]
    assert [k for x in lists for k in x] == keys
    assert store.requests == 3


def test_r2_store_falls_back_to_a_request_per_key_when_the_list_is_refused() -> None:
    single: list[str] = []
    refused = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal refused
        if request.url.path.endswith("/objects"):
            refused += 1
            refusal = {"success": False, "errors": [{"message": "method not allowed"}]}
            return httpx.Response(405, json=refusal)
        single.append(request.url.path.rsplit("/objects/", 1)[1])
        return httpx.Response(204)

    store = R2Store("acct", "tok", transport=httpx.MockTransport(handler), sleep=0.0)
    keys = [f"builds/b1/f{i}.json" for i in range(1500)]
    assert delete_many(store, keys) == 1500
    assert sorted(single) == sorted(keys)
    # refused once, then never tried again in the run
    assert refused == 1
    assert store.bulk_delete is False


def test_rollback_points_at_the_previous_build_and_prune_keeps_it(tmp_path: Path) -> None:
    store = LocalStore(tmp_path)
    for i in range(3):
        build_mod.publish(store, fake_build(f"b{i}"), keep=3, log=lambda _: None)
    pointer = build_mod.rollback(store, log=lambda _: None)
    assert pointer["build_id"] == "b1" and pointer["rolled_back_from"] == "b2"
    pointer = build_mod.rollback(store, to="b0", log=lambda _: None)
    assert pointer["build_id"] == "b0"
    # A new publish with keep=1 keeps the newest and the pinned build latest still points at.
    build_mod.publish(store, fake_build("b3"), keep=1, log=lambda _: None)
    builds = [b["build_id"] for b in json.loads(store.get("builds.json") or b"[]")]
    assert builds == ["b3", "b0"], "the rollback's pin holds and its build is kept"
    assert json.loads(store.get("latest.json") or b"{}")["build_id"] == "b0"
    with pytest.raises(RuntimeError, match=r"not in builds\.json"):
        build_mod.rollback(store, to="nope", log=lambda _: None)


def test_rollback_and_unpin_refuse_a_build_whose_files_are_gone(tmp_path: Path) -> None:
    """#405: a prune cancelled midway can leave builds.json naming a build with no files."""
    store = LocalStore(tmp_path)
    for i in range(3):
        build_mod.publish(store, fake_build(f"b{i}"), keep=3, log=lambda _: None)
    store.delete("builds/b1/manifest.json")
    with pytest.raises(RuntimeError, match="b1 is recorded but its manifest or key list is gone"):
        build_mod.rollback(store, log=lambda _: None)  # the previous build is b1
    assert json.loads(store.get("latest.json") or b"{}")["build_id"] == "b2", (
        "the pointer did not move"
    )
    pointer = build_mod.rollback(store, to="b0", log=lambda _: None)
    assert pointer["build_id"] == "b0"
    store.delete("builds/b2/keys.txt")
    with pytest.raises(RuntimeError, match="b2 is recorded but"):
        build_mod.unpin(store, log=lambda _: None)  # the newest build is b2
    latest, builds = build_mod.list_builds(store)
    assert latest["build_id"] == "b0" and latest["pinned"] is True
    assert {b["build_id"]: b.get("incomplete", False) for b in builds} == {
        "b2": True,
        "b1": True,
        "b0": False,
    }


def test_prune_keeps_a_pinned_build_whatever_latest_says(tmp_path: Path) -> None:
    """#277: the pin in builds.json protects the build on its own."""
    store = LocalStore(tmp_path)
    for i in range(3):
        build_mod.publish(store, fake_build(f"b{i}"), keep=3, log=lambda _: None)
    build_mod.rollback(store, to="b0", log=lambda _: None)
    # latest.json pointing elsewhere, as a stale concurrent promote could leave it
    store.put("latest.json", to_json({"build_id": "b2", "manifest": "builds/b2/manifest.json"}))
    dropped = build_mod.prune(store, keep=1, log=lambda _: None)
    assert dropped == ["b1"], "b2 is latest, b0 is pinned, only b1 goes"
    assert store.get("builds/b0/manifest.json") is not None
    assert [b["build_id"] for b in json.loads(store.get("builds.json") or b"[]")] == ["b2", "b0"]


def test_a_light_build_carries_the_newest_earlier_notebooks_and_extract(tmp_path: Path) -> None:
    """#530: the evening light build no longer goes live without notebooks or the extract."""
    store = LocalStore(tmp_path / "bucket")
    quiet = lambda _: None  # noqa: E731
    build_mod.publish(store, fake_build("b1"), log=quiet)
    page = tmp_path / "01_board_backtest.html"
    page.write_text("<html>old</html>", encoding="utf-8")
    csv = tmp_path / "player_value.csv"
    csv.write_bytes(b"league,player\nnba,A\n")
    build_mod.publish_files(store, [page], subdir="notebooks", build_id="b1", log=quiet)
    build_mod.publish_files(store, [csv], subdir="tableau", build_id="b1", log=quiet)
    build_mod.publish(store, fake_build("b2"), log=quiet)  # a full build whose notebooks failed
    build_mod.stage(store, fake_build("b3"), log=quiet)  # the light build, staged

    carried = build_mod.carry_forward(store, "b3", log=quiet)
    assert carried == {"notebooks": "b1", "tableau": "b1"}
    assert store.get("builds/b3/notebooks/01_board_backtest.html") == b"<html>old</html>"
    assert store.get("builds/b3/tableau/player_value.csv") == b"league,player\nnba,A\n"
    index = json.loads(store.get("builds/b3/notebooks/index.json") or b"{}")
    assert index["build_id"] == "b3"
    assert index["files"] == ["01_board_backtest.html"]
    assert index["carried_from"] == "b1"
    listing = (store.get("builds/b3/keys.txt") or b"").decode()
    assert "builds/b3/notebooks/01_board_backtest.html" in listing, "pruning removes the copies"
    assert "builds/b3/tableau/index.json" in listing

    # a second light build in a row names the build that rendered them, not the light one
    build_mod.promote(store, "b3", log=quiet)
    build_mod.stage(store, fake_build("b4"), log=quiet)
    assert build_mod.carry_forward(store, "b4", ("notebooks",), log=quiet) == {"notebooks": "b1"}
    again = json.loads(store.get("builds/b4/notebooks/index.json") or b"{}")
    assert again["carried_from"] == "b1"

    # nothing to carry: said, not invented
    fresh = LocalStore(tmp_path / "fresh")
    build_mod.publish(fresh, fake_build("x1"), log=quiet)
    build_mod.stage(fresh, fake_build("x2"), log=quiet)
    assert build_mod.carry_forward(fresh, "x2", log=quiet) == {"notebooks": None, "tableau": None}
    assert fresh.get("builds/x2/notebooks/index.json") is None


def test_findings_history_keeps_one_entry_per_build_and_league(tmp_path: Path) -> None:
    """#293: the findings outlive the seven kept builds."""
    store = LocalStore(tmp_path)
    for i in range(2):
        build_mod.publish(store, fake_build(f"b{i}"), keep=3, log=lambda _: None)
    nb = tmp_path / "nb"
    nb.mkdir()
    findings = nb / "01_board_backtest.findings.json"
    findings.write_text(
        json.dumps(
            {
                "title": "x",
                "leagues": {
                    "wnba": {
                        "headline": "top 30: 0.66",
                        "n": 120,
                        "facts": [{"label": "hit", "value": "0.66"}],
                    }
                },
            }
        )
    )
    build_mod.publish_files(
        store, [findings], subdir="notebooks", build_id="b0", log=lambda _: None
    )
    history = build_mod.findings_history(store, "b0", log=lambda _: None)
    series = history["notebooks"]["01_board_backtest"]["wnba"]
    assert [e["build_id"] for e in series] == ["b0"] and series[0]["facts"] == {"hit": "0.66"}
    # the same build again replaces its entry; a later build appends; the cap holds
    findings.write_text(
        json.dumps({"leagues": {"wnba": {"headline": "top 30: 0.70", "facts": []}}})
    )
    build_mod.publish_files(
        store, [findings], subdir="notebooks", build_id="b0", log=lambda _: None
    )
    build_mod.findings_history(store, "b0", log=lambda _: None)
    build_mod.publish_files(
        store, [findings], subdir="notebooks", build_id="b1", log=lambda _: None
    )
    history = build_mod.findings_history(store, "b1", keep=1, log=lambda _: None)
    series = history["notebooks"]["01_board_backtest"]["wnba"]
    assert [e["build_id"] for e in series] == ["b1"], "keep=1 leaves the newest build only"
    assert json.loads(store.get(build_mod.FINDINGS_HISTORY_KEY) or b"{}")["updated_at"]
    with pytest.raises(RuntimeError, match="no build"):
        build_mod.findings_history(LocalStore(tmp_path / "empty"), None, log=lambda _: None)


def test_a_rollback_holds_until_unpinned(tmp_path: Path) -> None:
    """#96 item 5: the next nightly build must not undo a rollback."""
    store = LocalStore(tmp_path)

    def quiet(_: str) -> None:
        return None

    for i in range(3):
        build_mod.publish(store, fake_build(f"b{i}"), keep=3, log=quiet)
    pointer = build_mod.rollback(store, to="b0", log=quiet)
    assert pointer["pinned"] is True
    builds = json.loads(store.get("builds.json") or b"[]")
    assert [b["build_id"] for b in builds if b.get("pinned")] == ["b0"]
    log: list[str] = []
    latest = build_mod.publish(store, fake_build("b3"), keep=3, log=log.append)
    assert latest["build_id"] == "b0", "the nightly build did not undo the rollback"
    assert json.loads(store.get("latest.json") or b"{}")["build_id"] == "b0"
    assert any("pinned" in line for line in log)
    builds = json.loads(store.get("builds.json") or b"[]")
    assert builds[0]["build_id"] == "b3", "the new build is recorded"
    assert store.get("builds/b0/manifest.json") is not None, "the pinned build is never pruned"
    pointer = build_mod.unpin(store, log=quiet)
    assert pointer["build_id"] == "b3" and "pinned" not in pointer
    assert not any(b.get("pinned") for b in json.loads(store.get("builds.json") or b"[]"))
    assert build_mod.publish(store, fake_build("b4"), keep=3, log=quiet)["build_id"] == "b4"


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
    # the column-wise copy is the row file column by column (#535)
    rows = json.loads(build.files["board/wnba.json"])
    columns = json.loads(build.files["board/wnba.columns.json"])
    assert list(columns) == list(rows[0]) if rows else columns == {}
    assert all(len(v) == len(rows) for v in columns.values())
    assert (
        "streamers/nba.columns.json" in build.files
        and "schedule/nba.columns.json" not in build.files
    )
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


def test_databricks_source_retries_a_warehouse_that_is_waking_up() -> None:
    """#402: the export's own queries retry a transient refusal, as the gate's do."""
    table = pa.table({"n": [7]})
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    ipc = sink.getvalue().to_pybytes()
    answers = [
        httpx.Response(
            400, json={"message": "The request could not be processed by the warehouse."}
        ),
        httpx.Response(503, text="unavailable"),
        httpx.Response(
            200,
            json={
                "statement_id": "s1",
                "status": {"state": "SUCCEEDED"},
                "manifest": {"schema": {"columns": [{"name": "n"}]}},
                "result": {
                    "external_links": [{"chunk_index": 0, "external_link": "https://links/0"}]
                },
            },
        ),
    ]
    pauses: list[float] = []
    source = DatabricksSource(
        "https://x",
        "t",
        "w",
        transport=httpx.MockTransport(lambda request: answers.pop(0)),
        link_transport=httpx.MockTransport(lambda request: httpx.Response(200, content=ipc)),
        sleep=0.0,
        pause=pauses.append,
    )
    out = source.query("select 7 as n")
    assert out.to_pylist() == [{"n": 7}]
    assert pauses == [5.0, 10.0]
    # a refusal that is not transient fails at once, without waiting
    bad = DatabricksSource(
        "https://x",
        "t",
        "w",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(400, json={"message": "Invalid warehouse id"})
        ),
        pause=pauses.append,
    )
    with pytest.raises(RuntimeError, match="Invalid warehouse id"):
        bad.query("select 1")
    assert pauses == [5.0, 10.0]
    assert sum(source_mod.SUBMISSION_PAUSES) >= 300, "about five minutes of retries in all"


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
