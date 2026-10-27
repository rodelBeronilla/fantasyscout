from __future__ import annotations

import random
from datetime import UTC, date, datetime
from pathlib import Path

import httpx

from ingest.espn import (
    EspnIngestor,
    EspnPlanner,
    days_between,
    events_from_scoreboard,
    team_ids_from_teams,
)
from ingest.http import Throttle, ThrottledClient
from ingest.store import Landing, LocalBackend

FIXTURES = Path(__file__).parent / "fixtures" / "espn"


def fixture(name: str) -> bytes:
    return (FIXTURES / f"{name}.json").read_bytes()


def fixture_client(fail: set[str] | None = None) -> ThrottledClient:
    fail = fail or set()

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        assert path.startswith("/apis/site/v2/sports/basketball/wnba/")
        if path.endswith("/scoreboard"):
            name = "scoreboard"
        elif path.endswith("/summary"):
            name = "summary"
        elif path.endswith("/teams"):
            name = "teams"
        elif path.endswith("/roster"):
            name = "roster"
        elif path.endswith("/injuries"):
            name = "injuries"
        else:
            return httpx.Response(404)
        if name in fail:
            return httpx.Response(503)
        return httpx.Response(200, content=fixture(name))

    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def test_days_between_is_inclusive_and_ordered() -> None:
    assert days_between(date(2026, 9, 23), date(2026, 9, 25)) == [
        date(2026, 9, 23),
        date(2026, 9, 24),
        date(2026, 9, 25),
    ]
    assert days_between(date(2026, 9, 25), date(2026, 9, 23)) == []


def test_planner_paths_and_keys() -> None:
    sb = EspnPlanner.scoreboard_request(date(2026, 9, 24))
    assert sb.key == "20260924" and sb.params == {"dates": "20260924", "limit": "100"}
    assert (
        sb.url("wnba") == "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard"
    )
    assert EspnPlanner.roster_request("14").url("nba").endswith("/nba/teams/14/roster")
    assert EspnPlanner.summary_request("401").params == {"event": "401"}
    assert EspnPlanner.injuries_request().key == "league"


def test_events_from_scoreboard_fixture() -> None:
    events = events_from_scoreboard(fixture("scoreboard"))
    assert len(events) == 1
    event = events[0]
    assert event.event_id.isdigit()
    assert event.event_date == date(2026, 9, 24)
    assert event.completed is True
    assert len(event.team_ids) == 2


def test_team_ids_from_teams_fixture() -> None:
    ids = team_ids_from_teams(fixture("teams"))
    assert len(ids) == 2 and ids == sorted(ids)


def test_run_lands_scoreboards_summaries_rosters_and_injuries(tmp_path: Path) -> None:
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    planner = EspnPlanner("wnba", "2026")
    summary = EspnIngestor(
        fixture_client(), Landing(LocalBackend(tmp_path), ingest_date=now.date()), planner, now=now
    ).run(since=date(2026, 9, 23), until=date(2026, 9, 24))
    # 2 scoreboards (same fixture, so one distinct event -> 1 summary), teams, 2 rosters, injuries
    assert summary.ok, summary.failures
    assert summary.games == 1
    assert summary.landed == 2 + 1 + 1 + 2 + 1
    assert (tmp_path / "landing/espn/scoreboard/wnba/2026/2026-10-27/20260924.json").exists()
    assert (tmp_path / "landing/espn/injuries/wnba/2026/2026-10-27/league.json").exists()

    again = EspnIngestor(
        fixture_client(fail={"scoreboard", "summary", "teams", "roster", "injuries"}),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        planner,
        now=now,
    ).run(since=date(2026, 9, 23), until=date(2026, 9, 24))
    assert again.ok and again.landed == 0 and again.skipped == 7
    assert again.games == 1, "events are re-planned from the landed scoreboards"


def test_scoreboard_failure_is_recorded_and_the_rest_proceeds(tmp_path: Path) -> None:
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = EspnIngestor(
        fixture_client(fail={"scoreboard"}),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        EspnPlanner("wnba", "2026"),
        now=now,
    ).run(since=date(2026, 9, 24), until=date(2026, 9, 24), rosters=False)
    assert [f.endpoint for f in summary.failures] == ["scoreboard"]
    assert summary.games == 0
    assert summary.landed == 1  # injuries still landed


def test_missing_summary_is_recorded_not_failed(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/summary"):
            return httpx.Response(404, json={"code": 404, "message": "not found"})
        name = "scoreboard" if path.endswith("/scoreboard") else "injuries"
        return httpx.Response(200, content=fixture(name))

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = EspnIngestor(
        client,
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        EspnPlanner("wnba", "2026"),
        now=now,
    ).run(since=date(2026, 9, 24), until=date(2026, 9, 24), rosters=False)
    assert summary.ok, "a 404 summary must not fail the run"
    assert [m.endpoint for m in summary.missing] == ["summary"]
    assert "no summary at source" in summary.missing[0].reason
    assert summary.landed == 2  # scoreboard and injuries
