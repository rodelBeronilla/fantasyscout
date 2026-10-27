from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path, PurePosixPath

import httpx
import pytest

from ingest.store import INDEX_NAME, Landing, LocalBackend, Scope, VolumeBackend

SCOPE = Scope(source="stats", endpoint="leaguegamelog", league="wnba", season="2026")
FETCHED = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)


def _land(landing: Landing, key: str, body: bytes):  # type: ignore[no-untyped-def]
    return landing.land(
        SCOPE,
        key,
        body,
        url="https://stats.wnba.com/stats/leaguegamelog",
        params={"LeagueID": "10"},
        status=200,
        fetched_at=FETCHED,
    )


def test_scope_index_lives_next_to_the_season_folders() -> None:
    assert SCOPE.index_path() == PurePosixPath(
        f"landing/stats/leaguegamelog/wnba/2026/{INDEX_NAME}"
    )


def test_land_writes_payload_sidecar_and_index(tmp_path: Path) -> None:
    landing = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27))
    result = _land(landing, "0012600001", b'{"resultSets": []}')
    landing.flush()

    assert result.outcome == "landed"
    payload = tmp_path / "landing/stats/leaguegamelog/wnba/2026/2026-10-27/0012600001.json"
    assert payload.read_bytes() == b'{"resultSets": []}'
    sidecar = json.loads(payload.with_suffix(".meta.json").read_text(encoding="utf-8"))
    assert sidecar["sha256"] == result.sha256
    assert sidecar["size_bytes"] == 18
    index = json.loads(
        (tmp_path / "landing/stats/leaguegamelog/wnba/2026" / INDEX_NAME).read_text()
    )
    assert index["0012600001"]["ingest_date"] == "2026-10-27"


def test_rerun_is_a_no_op(tmp_path: Path) -> None:
    first = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27))
    _land(first, "k", b"same")
    first.flush()

    # Same day: the planner should not even fetch.
    again = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27))
    assert again.already_landed_today(SCOPE, "k") is True
    assert again.already_landed_today(SCOPE, "other") is False

    # Next day, same bytes: fetched, but nothing new is written.
    next_day = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 28))
    assert next_day.already_landed_today(SCOPE, "k") is False
    result = _land(next_day, "k", b"same")
    assert result.outcome == "unchanged"
    assert result.path.as_posix().endswith("2026-10-27/k.json")
    assert not (tmp_path / "landing/stats/leaguegamelog/wnba/2026/2026-10-28").exists()

    # Changed bytes land under the new date.
    result = _land(next_day, "k", b"changed")
    assert result.outcome == "landed"
    assert "2026-10-28" in result.path.as_posix()


def test_full_refresh_bypasses_both_checks(tmp_path: Path) -> None:
    first = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27))
    _land(first, "k", b"same")
    first.flush()
    refresh = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27), full_refresh=True)
    assert refresh.already_landed_today(SCOPE, "k") is False
    assert _land(refresh, "k", b"same").outcome == "landed"


def test_volume_backend_uses_the_files_api(tmp_path: Path) -> None:
    calls: list[tuple[str, str]] = []
    store: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["Authorization"] == "Bearer tok"
        if request.url.path.startswith("/api/2.0/fs/directories/"):
            return httpx.Response(204)
        key = request.url.path.removeprefix("/api/2.0/fs/files")
        if request.method == "PUT":
            assert request.url.params["overwrite"] == "true"
            store[key] = request.content
            return httpx.Response(204)
        if key in store:
            return httpx.Response(200, content=store[key])
        return httpx.Response(404, json={"error_code": "NOT_FOUND"})

    backend = VolumeBackend(
        "https://dbc-1.cloud.databricks.com/", "tok", transport=httpx.MockTransport(handler)
    )
    landing = Landing(backend, ingest_date=date(2026, 10, 27))
    assert landing.already_landed_today(SCOPE, "k") is False  # index GET -> 404
    _land(landing, "k", b"body")
    landing.flush()

    assert (
        "GET",
        "/api/2.0/fs/files/Volumes/fantasyscout/raw/landing/stats/leaguegamelog/wnba/2026/_index.json",
    ) in calls
    assert (
        "PUT",
        "/api/2.0/fs/directories/Volumes/fantasyscout/raw/landing/stats/leaguegamelog/wnba/2026/2026-10-27",
    ) in calls
    assert (
        store["/Volumes/fantasyscout/raw/landing/stats/leaguegamelog/wnba/2026/2026-10-27/k.json"]
        == b"body"
    )
    assert "/Volumes/fantasyscout/raw/landing/stats/leaguegamelog/wnba/2026/_index.json" in store
    # the directory is created once per run, not once per file
    assert (
        sum(1 for m, p in calls if m == "PUT" and "/directories/" in p and p.endswith("2026-10-27"))
        == 1
    )

    # A second Landing over the same backend sees the index and treats the key as landed today.
    again = Landing(backend, ingest_date=date(2026, 10, 27))
    assert again.already_landed_today(SCOPE, "k") is True
    backend.close()


def test_ensure_volume_checks_then_creates_missing_objects() -> None:
    calls: list[tuple[str, str]] = []
    present = {"/api/2.1/unity-catalog/catalogs/fantasyscout"}  # the catalog exists already

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        if request.method == "GET":
            return httpx.Response(200 if request.url.path in present else 404, json={})
        payload = json.loads(request.content)
        return httpx.Response(200, json=payload)

    backend = VolumeBackend(
        "https://dbc-1.cloud.databricks.com", "tok", transport=httpx.MockTransport(handler)
    )
    assert backend.ensure_volume() == {
        "catalog": "exists",
        "schema": "created",
        "volume": "created",
    }
    assert calls == [
        ("GET", "/api/2.1/unity-catalog/catalogs/fantasyscout"),
        ("GET", "/api/2.1/unity-catalog/schemas/fantasyscout.raw"),
        ("POST", "/api/2.1/unity-catalog/schemas"),
        ("GET", "/api/2.1/unity-catalog/volumes/fantasyscout.raw.landing"),
        ("POST", "/api/2.1/unity-catalog/volumes"),
    ]
    backend.close()


def test_ensure_volume_explains_the_free_edition_catalog_rule() -> None:
    body = {
        "error_code": "INVALID_STATE",
        "message": "Metastore storage root URL does not exist. Default Storage is enabled ...",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/catalogs"):
            return httpx.Response(200, json={"catalogs": [{"name": "workspace"}]})
        if request.method == "GET":
            return httpx.Response(404, json={})
        return httpx.Response(400, json=body)

    backend = VolumeBackend(
        "https://dbc-1.cloud.databricks.com", "tok", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(RuntimeError) as excinfo:
        backend.ensure_volume()
    assert "create it once in the workspace UI" in str(excinfo.value)
    assert "Catalogs visible to this token: ['workspace']" in str(excinfo.value)


def test_ensure_volume_raises_on_real_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(404, json={})
        return httpx.Response(403, json={"error_code": "PERMISSION_DENIED"})

    backend = VolumeBackend(
        "https://dbc-1.cloud.databricks.com", "tok", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(RuntimeError, match="PERMISSION_DENIED"):
        backend.ensure_volume()
    with pytest.raises(ValueError, match="/Volumes/<catalog>/<schema>"):
        VolumeBackend("https://x", "t", root="/Volumes/only").ensure_volume()


class FlakyBackend(LocalBackend):
    """Fails the payload write for one key so the failure path can be asserted."""

    def write_bytes(self, path: PurePosixPath, body: bytes) -> None:
        if path.name == "bad.json":
            raise RuntimeError("disk full")
        super().write_bytes(path, body)


def test_threaded_writes_overlap_and_failures_are_reported(tmp_path: Path) -> None:
    landing = Landing(FlakyBackend(tmp_path), ingest_date=date(2026, 10, 27), workers=4)
    assert _land(landing, "good", b"ok").outcome == "landed"
    assert _land(landing, "bad", b"nope").outcome == "landed"  # queued; failure surfaces at flush
    failures = landing.flush()
    landing.close()
    assert [(f.endpoint, f.key) for f in failures] == [("leaguegamelog", "bad")]
    assert "disk full" in str(failures[0].error)
    assert (tmp_path / "landing/stats/leaguegamelog/wnba/2026/2026-10-27/good.json").exists()
    index = json.loads(
        (tmp_path / "landing/stats/leaguegamelog/wnba/2026" / INDEX_NAME).read_text()
    )
    assert "good" in index and "bad" not in index, "a failed write must not be indexed as landed"


def test_volume_writes_retry_on_rate_limiting(monkeypatch: pytest.MonkeyPatch) -> None:
    from pathlib import PurePosixPath

    from ingest import store as store_mod
    from ingest.store import VolumeBackend

    sleeps: list[float] = []
    monkeypatch.setattr(store_mod.time, "sleep", sleeps.append)
    puts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal puts
        if request.url.path.startswith("/api/2.0/fs/directories"):
            return httpx.Response(204)
        puts += 1
        if puts < 3:
            return httpx.Response(429, headers={"retry-after": "5"}, text="RESOURCE_EXHAUSTED")
        return httpx.Response(204)

    backend = VolumeBackend(
        "https://dbc-1.cloud.databricks.com", "t", transport=httpx.MockTransport(handler)
    )
    backend.write_bytes(PurePosixPath("landing/stats/x/wnba/2023/2026-10-27/a.json"), b"{}")
    assert puts == 3
    assert sleeps and all(s >= 5 for s in sleeps), "Retry-After is honoured"
    backend.close()


def test_volume_writes_give_up_after_the_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    from pathlib import PurePosixPath

    from ingest import store as store_mod
    from ingest.store import VolumeBackend

    monkeypatch.setattr(store_mod.time, "sleep", lambda _: None)
    backend = VolumeBackend(
        "https://dbc-1.cloud.databricks.com",
        "t",
        transport=httpx.MockTransport(lambda r: httpx.Response(503, text="busy")),
    )
    with pytest.raises(RuntimeError, match="HTTP 503"):
        backend.write_bytes(PurePosixPath("landing/stats/x/wnba/2023/2026-10-27/a.json"), b"{}")
    backend.close()
