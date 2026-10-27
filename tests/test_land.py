from __future__ import annotations

import json
import random
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest

from ingest import land as land_mod
from ingest.http import Throttle, ThrottledClient
from ingest.land import LandOptions, default_season, land, make_backend, plan_lines, run_log_path
from ingest.run import RunSummary
from ingest.store import LocalBackend, VolumeBackend

FIXTURES = Path(__file__).parent / "fixtures"


def test_default_season_follows_each_league_calendar() -> None:
    assert default_season("wnba", date(2026, 10, 27)) == "2026"
    assert default_season("wnba", date(2027, 2, 1)) == "2026"
    assert default_season("nba", date(2026, 10, 27)) == "2026-27"
    assert default_season("nba", date(2026, 3, 1)) == "2025-26"


def test_make_backend_needs_databricks_env_for_volume(tmp_path: Path) -> None:
    assert isinstance(make_backend("local", tmp_path), LocalBackend)
    with pytest.raises(SystemExit):
        make_backend("volume", tmp_path, env={})
    backend = make_backend(
        "volume",
        tmp_path,
        env={"DATABRICKS_HOST": "https://dbc-1.cloud.databricks.com/?o=1", "DATABRICKS_TOKEN": "t"},
    )
    assert isinstance(backend, VolumeBackend)
    assert backend.host == "https://dbc-1.cloud.databricks.com"
    backend.close()


def test_plan_lines_describe_both_sources() -> None:
    stats = plan_lines(LandOptions("stats", "wnba"), "2026", date(2026, 9, 18), date(2026, 9, 24))
    assert "stats wnba 2026" in stats[0]
    assert any("leaguegamelog" in line for line in stats)
    espn = plan_lines(LandOptions("espn", "nba"), "2025-26", date(2026, 4, 1), date(2026, 4, 7))
    assert any("scoreboard for 7 day(s)" in line for line in espn)


def test_run_log_path_is_dated_and_unique() -> None:
    summary = RunSummary("espn", "wnba", "2026", datetime(2026, 10, 27, 9, 15, tzinfo=UTC))
    path = run_log_path(summary, "abc123")
    assert path.as_posix() == "landing/_ops/ingest_log/2026-10-27/espn-wnba-2026-abc123.json"


def test_dry_run_prints_the_plan_and_touches_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    result = land(
        LandOptions("stats", "wnba", dry_run=True, root=tmp_path), today=date(2026, 10, 27)
    )
    assert result is None
    assert "window 2026-10-21 to 2026-10-27" in capsys.readouterr().out
    assert not (tmp_path / "landing").exists()


def test_land_runs_espn_locally_and_writes_the_run_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        if name == "injuries":
            return httpx.Response(503, text="down")
        return httpx.Response(200, content=(FIXTURES / "espn" / f"{name}.json").read_bytes())

    def fake_client(*_: object, **__: object) -> ThrottledClient:
        return ThrottledClient(
            Throttle(max_retries=0),
            transport=httpx.MockTransport(handler),
            sleep=lambda _: None,
            clock=lambda: 0.0,
            rng=random.Random(0),
        )

    monkeypatch.setattr(land_mod, "ThrottledClient", fake_client)
    opts = LandOptions(
        "espn", "wnba", since=date(2026, 9, 24), until=date(2026, 9, 24), root=tmp_path
    )
    summary = land(opts, today=date(2026, 10, 27), env={})
    assert summary is not None
    assert (
        summary.games == 1 and summary.landed == 1 + 1 + 1 + 2
    )  # scoreboard, summary, teams, 2 rosters
    assert [f.endpoint for f in summary.failures] == ["injuries"]

    logs = list((tmp_path / "landing/_ops/ingest_log/2026-10-27").glob("espn-wnba-2026-*.json"))
    assert len(logs) == 1
    record = json.loads(logs[0].read_text(encoding="utf-8"))
    assert record["landed"] == 5 and record["failures"][0]["endpoint"] == "injuries"
    assert record["window"] == {"since": "2026-09-24", "until": "2026-09-24"}
    out = capsys.readouterr().out
    assert "1 games in window, 5 landed" in out and "failed injuries/league" in out


def test_ensure_landing_dirs_creates_every_known_endpoint(tmp_path: Path) -> None:
    from ingest.land import ENDPOINT_DIRS, ensure_landing_dirs

    count = ensure_landing_dirs(LocalBackend(tmp_path))
    assert count == 1 + sum(len(v) for v in ENDPOINT_DIRS.values())
    assert (tmp_path / "landing/stats/playergamelogs").is_dir()
    assert (tmp_path / "landing/espn/injuries").is_dir()
    assert (tmp_path / "landing/_ops/ingest_log").is_dir()
    assert ensure_landing_dirs(LocalBackend(tmp_path)) == count  # idempotent


def test_volume_backend_ensure_directory_puts_once(tmp_path: Path) -> None:
    from pathlib import PurePosixPath

    from ingest.store import VolumeBackend

    puts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        puts.append(request.url.path)
        return httpx.Response(204)

    backend = VolumeBackend(
        "https://dbc-1.cloud.databricks.com", "t", transport=httpx.MockTransport(handler)
    )
    backend.ensure_directory(PurePosixPath("landing/stats/playergamelogs"))
    backend.ensure_directory(PurePosixPath("landing/stats/playergamelogs"))
    assert puts == ["/api/2.0/fs/directories/Volumes/fantasyscout/raw/landing/stats/playergamelogs"]
    backend.close()
