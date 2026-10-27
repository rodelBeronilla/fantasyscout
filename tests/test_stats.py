from __future__ import annotations

import json
import random
from datetime import UTC, date, datetime
from pathlib import Path

import httpx

from ingest.http import Throttle, ThrottledClient
from ingest.run import describe
from ingest.stats import (
    StatsIngestor,
    StatsPlanner,
    games_in_window,
    parse_result_set,
    season_label,
)
from ingest.store import Landing, LocalBackend

FIXTURES = Path(__file__).parent / "fixtures" / "stats"


def fixture(endpoint: str) -> bytes:
    return (FIXTURES / f"{endpoint}.json").read_bytes()


def fixture_client(status_for: dict[str, int] | None = None) -> ThrottledClient:
    """A client that answers every stats endpoint from the recorded fixtures."""
    status_for = status_for or {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-nba-stats-origin"] == "stats"
        endpoint = request.url.path.rsplit("/", 1)[-1]
        status = status_for.get(endpoint, 200)
        if status != 200:
            return httpx.Response(status, text="nope")
        return httpx.Response(200, content=fixture(endpoint))

    return ThrottledClient(
        Throttle(max_retries=1),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def test_season_labels() -> None:
    assert season_label("wnba", 2026) == "2026"
    assert season_label("nba", 2025) == "2025-26"
    assert season_label("nba", 2029) == "2029-30"


def test_planner_requests_have_stable_keys_and_required_params() -> None:
    planner = StatsPlanner("wnba", "2026")
    season = {r.endpoint: r for r in planner.season_requests()}
    assert set(season) == {"scheduleleaguev2", "commonallplayers", "leaguegamelog"}
    assert season["leaguegamelog"].key == "team-regular-season"
    assert season["leaguegamelog"].params["LeagueID"] == "10"
    assert season["scheduleleaguev2"].url("wnba") == "https://stats.wnba.com/stats/scheduleleaguev2"

    game = {r.endpoint: r for r in planner.game_requests("1022600330")}
    assert set(game) == {
        "boxscoretraditionalv3",
        "boxscoreadvancedv3",
        "playbyplayv3",
        "shotchartdetail",
    }
    assert all(r.key == "1022600330" for r in game.values())
    shots = game["shotchartdetail"].params
    assert shots["ContextMeasure"] == "FGA" and shots["TeamID"] == "0" and shots["PlayerID"] == "0"
    assert shots["SeasonType"] == "Regular Season" and "RookieYear" in shots

    rosters = planner.roster_requests(["2", "1", "2"])
    assert [r.key for r in rosters] == ["1", "2"]
    assert rosters[0].url("nba") == "https://stats.nba.com/stats/commonteamroster"
    assert StatsPlanner("nba", "2025-26", "Playoffs").gamelog_request().key == "team-playoffs"


def test_parse_result_set_zips_headers_and_rows() -> None:
    rows = parse_result_set(fixture("leaguegamelog"))
    assert rows and {"GAME_ID", "GAME_DATE", "TEAM_ID", "PTS"} <= set(rows[0])
    assert parse_result_set(fixture("leaguegamelog"), "does-not-exist") == []
    assert parse_result_set(b'{"resultSets": []}') == []


def test_games_in_window_filters_and_groups_both_team_rows() -> None:
    games = games_in_window(fixture("leaguegamelog"))
    assert games, "fixture must contain at least one game"
    assert all(g.game_id.startswith("1022") for g in games)
    assert all(1 <= len(g.team_ids) <= 2 for g in games)
    assert games == sorted(games, key=lambda g: (g.game_date, g.game_id))
    first, last = games[0].game_date, games[-1].game_date
    assert games_in_window(fixture("leaguegamelog"), since=last) == [
        g for g in games if g.game_date >= last
    ]
    assert games_in_window(fixture("leaguegamelog"), until=first) == [
        g for g in games if g.game_date <= first
    ]
    assert games_in_window(fixture("leaguegamelog"), since=date(2099, 1, 1)) == []


def test_run_lands_everything_then_reruns_as_a_no_op(tmp_path: Path) -> None:
    planner = StatsPlanner("wnba", "2026")
    games = games_in_window(fixture("leaguegamelog"))
    teams = {t for g in games for t in g.team_ids}
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)

    first = StatsIngestor(
        fixture_client(), Landing(LocalBackend(tmp_path), ingest_date=now.date()), planner, now=now
    ).run()
    expected = 3 + 4 * len(games) + len(teams)
    assert first.ok, first.failures
    assert first.games == len(games)
    assert first.landed == expected and first.unchanged == 0 and first.skipped == 0
    assert (
        tmp_path / "landing/stats/leaguegamelog/wnba/2026/2026-10-27/team-regular-season.json"
    ).exists()
    assert (tmp_path / "landing/stats/shotchartdetail/wnba/2026/_index.json").exists()
    sidecar = json.loads(
        (
            tmp_path
            / "landing/stats/leaguegamelog/wnba/2026/2026-10-27/team-regular-season.meta.json"
        ).read_text()
    )
    assert sidecar["params"]["LeagueID"] == "10" and sidecar["status"] == 200

    requests_made = 0

    def counting(request: httpx.Request) -> httpx.Response:
        nonlocal requests_made
        requests_made += 1
        return httpx.Response(500)

    silent = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(counting),
        sleep=lambda _: None,
        clock=lambda: 0.0,
    )
    again = StatsIngestor(
        silent, Landing(LocalBackend(tmp_path), ingest_date=now.date()), planner, now=now
    ).run()
    assert requests_made == 0, "a same-day rerun must not touch the network"
    assert again.ok and again.skipped == expected and again.landed == 0
    assert again.games == len(games), "game planning still works from the landed game log"


def test_failed_endpoint_is_recorded_and_the_rest_still_lands(tmp_path: Path) -> None:
    planner = StatsPlanner("wnba", "2026")
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = StatsIngestor(
        fixture_client({"boxscoreadvancedv3": 500}),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        planner,
        now=now,
    ).run()
    games = games_in_window(fixture("leaguegamelog"))
    assert not summary.ok
    assert len(summary.failures) == len(games)
    assert {f.endpoint for f in summary.failures} == {"boxscoreadvancedv3"}
    assert "HTTP 500" in summary.failures[0].reason
    assert summary.landed == 3 + 3 * len(games) + len({t for g in games for t in g.team_ids})
    text = "\n".join(describe(summary))
    assert "failed boxscoreadvancedv3/" in text and f"{len(games)} games in window" in text


def test_gamelog_failure_stops_game_planning(tmp_path: Path) -> None:
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = StatsIngestor(
        fixture_client({"leaguegamelog": 403}),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        StatsPlanner("wnba", "2026"),
        now=now,
    ).run()
    assert summary.games == 0 and summary.landed == 2
    assert [f.endpoint for f in summary.failures] == ["leaguegamelog"]


def test_team_season_scope_fetches_shots_once_per_team(tmp_path: Path) -> None:
    planner = StatsPlanner("wnba", "2026", shots_scope="team-season")
    assert [r.endpoint for r in planner.game_requests("x")] == [
        "boxscoretraditionalv3",
        "boxscoreadvancedv3",
        "playbyplayv3",
    ]
    shots = planner.shot_requests(["2", "1"])
    assert [r.key for r in shots] == ["1-regular-season", "2-regular-season"]
    assert shots[0].params["GameID"] == "" and shots[0].params["TeamID"] == "1"
    assert StatsPlanner("wnba", "2026").shot_requests(["1"]) == []

    games = games_in_window(fixture("leaguegamelog"))
    teams = {t for g in games for t in g.team_ids}
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = StatsIngestor(
        fixture_client(), Landing(LocalBackend(tmp_path), ingest_date=now.date()), planner, now=now
    ).run()
    assert summary.ok, summary.failures
    assert summary.landed == 3 + 3 * len(games) + len(teams) + len(teams)
    assert (tmp_path / "landing/stats/shotchartdetail/wnba/2026/2026-10-27").exists()
    assert not any(
        p.name.startswith("1022")
        for p in (tmp_path / "landing/stats/shotchartdetail/wnba/2026/2026-10-27").iterdir()
    ), "no per-game shot payloads in team-season scope"
