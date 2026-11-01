"""A replay lands only what it is asked for: --only, or a run log's failed keys (#250)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest

from ingest import land as land_mod
from ingest.http import Throttle, ThrottledClient
from ingest.land import LandOptions, land
from ingest.run import FetchFailure, Only, RunSummary, only_from_run_log
from ingest.stats import StatsIngestor, StatsPlanner, games_in_window
from ingest.store import Landing, LocalBackend
from tests.test_stats import fixture, fixture_client

FIXTURES = Path(__file__).parent / "fixtures"


def test_only_parses_endpoints_and_endpoint_key_pairs() -> None:
    only = Only.parse(["boxscoretraditionalv3", "playbyplayv3:1022600330", " "])
    assert only
    assert only.allows("boxscoretraditionalv3", "anything")
    assert only.allows("playbyplayv3", "1022600330")
    assert not only.allows("playbyplayv3", "1022600331")
    assert not only.allows("shotchartdetail", "1022600330")
    assert not Only.parse([])
    assert list(Only.parse(["a:1", "b"]).specs()) == ["a:1", "b"]


def test_only_from_a_run_log_takes_its_failures_and_missing_payloads() -> None:
    summary = RunSummary("stats", "wnba", "2026", datetime(2026, 10, 27, tzinfo=UTC))
    summary.failures.append(FetchFailure("boxscoretraditionalv3", "1022600330", "HTTP 500"))
    summary.missing.append(FetchFailure("shotchartdetail", "1611661319", "HTTP 404"))
    only = only_from_run_log(json.dumps(summary.to_dict()).encode("utf-8"))
    assert sorted(only.specs()) == [
        "boxscoretraditionalv3:1022600330",
        "shotchartdetail:1611661319",
    ]
    merged = only.merged(Only.parse(["playbyplayv3"]))
    assert merged.allows("playbyplayv3", "x") and merged.allows("shotchartdetail", "1611661319")


def test_a_stats_run_limited_to_one_key_still_plans_from_the_game_log(tmp_path: Path) -> None:
    planner = StatsPlanner("wnba", "2026")
    games = games_in_window(fixture("leaguegamelog"))
    target = games[0].game_id
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = StatsIngestor(
        fixture_client(),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        planner,
        now=now,
        only=Only.parse([f"boxscoretraditionalv3:{target}"]),
    ).run()
    assert summary.ok, summary.failures
    # the game log and the player directory (planning) and the one box score, nothing else
    assert summary.landed == 3, summary
    assert summary.games == len(games)
    assert (
        tmp_path / f"landing/stats/boxscoretraditionalv3/wnba/2026/2026-10-27/{target}.json"
    ).exists()
    assert not (tmp_path / "landing/stats/playbyplayv3/wnba/2026").exists()
    assert not (tmp_path / "landing/stats/leaguestandingsv3").exists()


def test_land_replays_a_run_logs_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # First run: the injuries listing fails and is named in the run log.
    attempts: dict[str, int] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        attempts[name] = attempts.get(name, 0) + 1
        if name == "injuries" and attempts[name] == 1:
            return httpx.Response(503, text="down")
        return httpx.Response(200, content=(FIXTURES / "espn" / f"{name}.json").read_bytes())

    def fake_client(*_: object, **__: object) -> ThrottledClient:
        return ThrottledClient(
            Throttle(max_retries=0),
            transport=httpx.MockTransport(handler),
            sleep=lambda _: None,
            clock=lambda: 0.0,
        )

    monkeypatch.setattr(land_mod, "ThrottledClient", fake_client)
    opts = LandOptions(
        "espn", "wnba", since=date(2026, 9, 24), until=date(2026, 9, 24), root=tmp_path
    )
    first = land(opts, today=date(2026, 10, 27), env={})
    assert first is not None and [f.endpoint for f in first.failures] == ["injuries"]
    log = next((tmp_path / "landing/_ops/ingest_log/2026-10-27").glob("espn-wnba-2026-*.json"))

    # The replay: only the failed key is fetched (the scoreboard still plans the day), and it lands.
    before = dict(attempts)
    replay = land(
        LandOptions(
            "espn",
            "wnba",
            since=date(2026, 9, 24),
            until=date(2026, 9, 24),
            root=tmp_path,
            from_run_log=log.relative_to(tmp_path).as_posix(),
        ),
        today=date(2026, 10, 27),
        env={},
    )
    assert replay is not None and replay.ok
    assert replay.landed == 1 and attempts["injuries"] == before["injuries"] + 1
    assert attempts.get("summary", 0) == before.get("summary", 0), "an unasked key is not fetched"
    assert (tmp_path / "landing/espn/injuries/wnba/2026/2026-10-27/league.json").exists()


def test_land_refuses_a_missing_run_log(tmp_path: Path) -> None:
    opts = LandOptions(
        "espn", "wnba", root=tmp_path, from_run_log="landing/_ops/ingest_log/none.json"
    )
    with pytest.raises(SystemExit):
        land(opts, today=date(2026, 10, 27), env={})


def test_dry_run_names_the_filter() -> None:
    opts = LandOptions("stats", "wnba", only=("boxscoretraditionalv3:1022600330",))
    lines = land_mod.plan_lines(opts, "2026", date(2026, 9, 18), date(2026, 9, 24))
    assert any("only" in line and "boxscoretraditionalv3:1022600330" in line for line in lines)
