from __future__ import annotations

import json
import random
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest

from ingest.http import Throttle, ThrottledClient
from ingest.land import LandOptions, plan_lines
from ingest.run import describe
from ingest.stats import (
    TRACKING_MEASURES,
    StatsIngestor,
    StatsPlanner,
    games_in_window,
    parse_result_set,
    season_label,
    teams_in_payload,
)
from ingest.store import Landing, LocalBackend

FIXTURES = Path(__file__).parent / "fixtures" / "stats"


# Season-level payloads every run lands: schedule, player directory, team game log, the three
# player game logs (Advanced, Usage, Misc) and standings.
SEASON_REQUESTS = 7


def fixture(endpoint: str) -> bytes:
    return (FIXTURES / f"{endpoint}.json").read_bytes()


def fixture_for(request: httpx.Request) -> bytes:
    """The recorded payload for a request: by endpoint, then by measure set where one applies."""
    endpoint = request.url.path.rsplit("/", 1)[-1]
    tracking = request.url.params.get("PtMeasureType")
    measure = request.url.params.get("MeasureType", "Advanced")
    if tracking:
        return fixture(f"{endpoint}_{tracking.lower()}")
    if endpoint == "playergamelogs" and measure != "Advanced":
        return fixture(f"{endpoint}_{measure.lower()}")
    return fixture(endpoint)


def fixture_client(status_for: dict[str, int] | None = None) -> ThrottledClient:
    """A client that answers every stats endpoint from the recorded fixtures."""
    status_for = status_for or {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-nba-stats-origin"] == "stats"
        endpoint = request.url.path.rsplit("/", 1)[-1]
        status = status_for.get(endpoint, 200)
        if status != 200:
            return httpx.Response(status, text="nope")
        return httpx.Response(200, content=fixture_for(request))

    return ThrottledClient(
        Throttle(max_retries=1),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def every_team() -> set[str]:
    """The teams a run fetches rosters for: the season's game log and the player directory."""
    return teams_in_payload(fixture("leaguegamelog")) | teams_in_payload(
        fixture("commonallplayers")
    )


def test_teams_in_payload_skips_players_without_a_team() -> None:
    teams = teams_in_payload(fixture("commonallplayers"))
    assert teams and "0" not in teams
    assert teams_in_payload(None) == set()


def test_rosters_land_for_every_team_with_no_games_in_the_window(tmp_path: Path) -> None:
    """Out of season there are no games, yet the board drafts from these rosters."""
    now = datetime(2026, 12, 1, 12, tzinfo=UTC)
    summary = StatsIngestor(
        fixture_client(),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        StatsPlanner("wnba", "2026"),
        now=now,
    ).run(since=date(2026, 11, 24), until=date(2026, 12, 1))
    assert summary.ok, summary.failures
    assert summary.games == 0
    rosters = {
        p.stem for p in (tmp_path / "landing/stats/commonteamroster/wnba/2026").rglob("*.json")
    }
    assert every_team() <= rosters


def test_season_labels() -> None:
    assert season_label("wnba", 2026) == "2026"
    assert season_label("nba", 2025) == "2025-26"
    assert season_label("nba", 2029) == "2029-30"


def test_planner_requests_have_stable_keys_and_required_params() -> None:
    planner = StatsPlanner("wnba", "2026")
    season = {(r.endpoint, r.key): r for r in planner.season_requests()}
    assert len(season) == len(planner.season_requests()) == SEASON_REQUESTS
    assert {endpoint for endpoint, _ in season} == {
        "scheduleleaguev2",
        "commonallplayers",
        "leaguegamelog",
        "playergamelogs",
        "leaguestandingsv3",
    }
    assert season["leaguestandingsv3", "regular-season"].params["SeasonType"] == "Regular Season"
    logs = {k: r.params["MeasureType"] for (e, k), r in season.items() if e == "playergamelogs"}
    assert logs == {
        "advanced-regular-season": "Advanced",
        "usage-regular-season": "Usage",
        "misc-regular-season": "Misc",
    }
    assert season["leaguegamelog", "team-regular-season"].params["LeagueID"] == "10"
    assert (
        season["scheduleleaguev2", "season"].url("wnba")
        == "https://stats.wnba.com/stats/scheduleleaguev2"
    )

    game = {r.endpoint: r for r in planner.game_requests("1022600330")}
    assert set(game) == {
        "boxscoretraditionalv3",
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
    teams = every_team()
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)

    first = StatsIngestor(
        fixture_client(), Landing(LocalBackend(tmp_path), ingest_date=now.date()), planner, now=now
    ).run()
    expected = SEASON_REQUESTS + 3 * len(games) + len(teams)
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
        fixture_client({"playbyplayv3": 500}),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        planner,
        now=now,
    ).run()
    games = games_in_window(fixture("leaguegamelog"))
    assert not summary.ok
    assert len(summary.failures) == len(games)
    assert {f.endpoint for f in summary.failures} == {"playbyplayv3"}
    assert "HTTP 500" in summary.failures[0].reason
    assert summary.landed == SEASON_REQUESTS + 2 * len(games) + len(every_team())
    text = "\n".join(describe(summary))
    assert "failed playbyplayv3/" in text and f"{len(games)} games in window" in text


def test_gamelog_failure_stops_game_planning_but_rosters_still_land(tmp_path: Path) -> None:
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = StatsIngestor(
        fixture_client({"leaguegamelog": 403}),
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        StatsPlanner("wnba", "2026"),
        now=now,
    ).run()
    # The other season requests, then a roster per team in the player directory.
    directory = teams_in_payload(fixture("commonallplayers"))
    assert summary.games == 0 and summary.landed == SEASON_REQUESTS - 1 + len(directory)
    assert [f.endpoint for f in summary.failures] == ["leaguegamelog"]
    rosters = {
        p.stem for p in (tmp_path / "landing/stats/commonteamroster/wnba/2026").rglob("*.json")
    }
    assert directory <= rosters


def test_team_season_scope_fetches_shots_once_per_team(tmp_path: Path) -> None:
    planner = StatsPlanner("wnba", "2026", shots_scope="team-season")
    assert [r.endpoint for r in planner.game_requests("x")] == [
        "boxscoretraditionalv3",
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
    assert summary.landed == SEASON_REQUESTS + 2 * len(games) + len(teams) + len(every_team())
    assert (tmp_path / "landing/stats/shotchartdetail/wnba/2026/2026-10-27").exists()
    assert not any(
        p.name.startswith("1022")
        for p in (tmp_path / "landing/stats/shotchartdetail/wnba/2026/2026-10-27").iterdir()
    ), "no per-game shot payloads in team-season scope"


def test_open_circuit_stops_the_run_and_keeps_what_landed(tmp_path: Path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        endpoint = request.url.path.rsplit("/", 1)[-1]
        if endpoint == "playbyplayv3":
            raise httpx.ReadTimeout("silence")
        return httpx.Response(200, content=fixture_for(request))

    client = ThrottledClient(
        Throttle(breaker_timeouts=2, max_retries=5),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    summary = StatsIngestor(
        client,
        Landing(LocalBackend(tmp_path), ingest_date=now.date()),
        StatsPlanner("wnba", "2026"),
        now=now,
    ).run()
    assert not summary.ok
    assert summary.aborted is not None and "likely blocked" in summary.aborted
    assert summary.landed >= SEASON_REQUESTS + 1, (
        "season payloads and the first box score landed before the stop"
    )
    assert calls <= SEASON_REQUESTS + 1 + 2, "no further requests after the circuit opened"
    assert summary.pacing["stats.wnba.com"]["slowdowns"] >= 1
    text = "\n".join(describe(summary))
    assert "ABORTED" in text and "pacing stats.wnba.com" in text


def test_progress_heartbeat_is_printed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    planner = StatsPlanner("wnba", "2026")
    now = datetime(2026, 10, 27, 12, tzinfo=UTC)
    ingestor = StatsIngestor(
        fixture_client(), Landing(LocalBackend(tmp_path), ingest_date=now.date()), planner, now=now
    )
    summary = ingestor.run()
    out = capsys.readouterr().out
    if summary.processed >= 25:
        assert "progress stats wnba 2026: 25 requests" in out
    else:
        assert "progress" not in out


def counting_client() -> tuple[ThrottledClient, dict[str, int]]:
    """The fixture client, counting requests per endpoint."""
    calls: dict[str, int] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        endpoint = request.url.path.rsplit("/", 1)[-1]
        calls[endpoint] = calls.get(endpoint, 0) + 1
        return httpx.Response(200, content=fixture_for(request))

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    return client, calls


def test_a_finished_game_is_fetched_until_settled_then_left_alone(tmp_path: Path) -> None:
    """Fixture games are played 2026-09-24; stat corrections are in two days later."""
    planner = StatsPlanner("wnba", "2026")
    games = len(games_in_window(fixture("leaguegamelog")))
    per_game = ("boxscoretraditionalv3", "playbyplayv3", "shotchartdetail")

    def run_on(day: date, *, full_refresh: bool = False) -> dict[str, int]:
        client, calls = counting_client()
        now = datetime(day.year, day.month, day.day, 12, tzinfo=UTC)
        landing = Landing(LocalBackend(tmp_path), ingest_date=day, full_refresh=full_refresh)
        summary = StatsIngestor(client, landing, planner, now=now).run()
        assert summary.ok, summary.failures
        return calls

    for day in (date(2026, 9, 25), date(2026, 9, 26)):  # the morning after, and once settled
        calls = run_on(day)
        assert all(calls.get(e) == games for e in per_game), calls
    later = run_on(date(2026, 9, 27))
    assert not any(later.get(e) for e in per_game), "a settled game is not fetched again"
    assert later.get("leaguegamelog") == 1 and later.get("commonteamroster")
    refreshed = run_on(date(2026, 9, 28), full_refresh=True)
    assert all(refreshed.get(e) == games for e in per_game), refreshed


def test_usage_and_misc_game_logs_are_one_call_per_season_in_both_leagues() -> None:
    for league, season in (("wnba", "2026"), ("nba", "2025-26")):
        planner = StatsPlanner(league, season, "Playoffs")  # type: ignore[arg-type]
        logs = {
            r.key: r.params for r in planner.season_requests() if r.endpoint == "playergamelogs"
        }
        assert set(logs) == {"advanced-playoffs", "usage-playoffs", "misc-playoffs"}
        assert logs["usage-playoffs"]["MeasureType"] == "Usage"
        assert logs["misc-playoffs"]["MeasureType"] == "Misc"
        assert all(
            p["SeasonType"] == "Playoffs" and p["PerMode"] == "Totals" for p in logs.values()
        )
        assert all(p["DateFrom"] == "" and p["Season"] == season for p in logs.values())
    rows = parse_result_set(fixture("playergamelogs_usage"))
    assert rows and {"GAME_ID", "PLAYER_ID", "PCT_FGA", "PCT_AST", "PCT_TOV"} <= set(rows[0])
    misc = parse_result_set(fixture("playergamelogs_misc"))
    assert misc and {"GAME_ID", "PLAYER_ID", "PFD", "BLKA", "PTS_PAINT"} <= set(misc[0])


def test_tracking_is_planned_per_game_date_for_the_nba_only() -> None:
    day = date(2026, 1, 15)
    assert StatsPlanner("wnba", "2026").day_requests(day) == []
    requests = StatsPlanner("nba", "2025-26").day_requests(day)
    assert [(r.endpoint, r.key) for r in requests] == [
        ("leaguedashptstats", "passing-2026-01-15"),
        ("leaguedashptstats", "rebounding-2026-01-15"),
        ("leaguedashptstats", "possessions-2026-01-15"),
        ("leaguedashptstats", "drives-2026-01-15"),
        ("leaguedashptstats", "speeddistance-2026-01-15"),
        ("leaguehustlestatsplayer", "hustle-2026-01-15"),
    ]
    assert [r.params["PtMeasureType"] for r in requests[:5]] == list(TRACKING_MEASURES)
    for r in requests:
        assert r.params["DateFrom"] == r.params["DateTo"] == "01/15/2026"
        assert r.params["PerMode"] == "Totals" and r.params["LeagueID"] == "00"
        assert r.params["Season"] == "2025-26" and r.params["SeasonType"] == "Regular Season"
    assert requests[0].url("nba") == "https://stats.nba.com/stats/leaguedashptstats"
    assert "PtMeasureType" not in requests[-1].params
    # Tracking starts with 2013-14 and hustle with 2015-16; earlier seasons plan neither.
    assert StatsPlanner("nba", "2012-13").day_requests(date(2013, 1, 15)) == []
    early = StatsPlanner("nba", "2014-15").day_requests(date(2015, 1, 15))
    assert {r.endpoint for r in early} == {"leaguedashptstats"} and len(early) == 5
    playoffs = StatsPlanner("nba", "2025-26", "Playoffs").day_requests(date(2026, 5, 1))
    assert playoffs and all(r.params["SeasonType"] == "Playoffs" for r in playoffs)


def test_tracking_fixtures_parse_to_one_row_per_player() -> None:
    names = [f"leaguedashptstats_{m.lower()}" for m in TRACKING_MEASURES]
    for name in [*names, "leaguehustlestatsplayer"]:
        rows = parse_result_set(fixture(name))
        assert rows, name
        assert {"PLAYER_ID", "TEAM_ID", "MIN"} <= set(rows[0]), name
        assert len({r["PLAYER_ID"] for r in rows}) == len(rows), name
    passing = parse_result_set(fixture("leaguedashptstats_passing"))[0]
    assert {"POTENTIAL_AST", "SECONDARY_AST", "PASSES_MADE"} <= set(passing)
    hustle = parse_result_set(fixture("leaguehustlestatsplayer"))[0]
    assert {"DEFLECTIONS", "CONTESTED_SHOTS", "BOX_OUTS"} <= set(hustle)


def test_nba_run_lands_tracking_per_game_date_until_settled(tmp_path: Path) -> None:
    """Fixture games are all played on 2026-09-24: one game date, six tracking calls."""
    planner = StatsPlanner("nba", "2025-26")
    dates = {g.game_date for g in games_in_window(fixture("leaguegamelog"))}
    assert dates == {date(2026, 9, 24)}
    tracking = {"leaguedashptstats": 5, "leaguehustlestatsplayer": 1}

    def run_on(day: date, *, until: date | None = None) -> dict[str, int]:
        client, calls = counting_client()
        now = datetime(day.year, day.month, day.day, 12, tzinfo=UTC)
        landing = Landing(LocalBackend(tmp_path), ingest_date=day)
        summary = StatsIngestor(client, landing, planner, now=now).run(until=until)
        assert summary.ok, summary.failures
        return {e: calls.get(e, 0) for e in tracking}

    assert run_on(date(2026, 9, 25)) == tracking
    landed = tmp_path / "landing/stats/leaguedashptstats/nba/2025-26/2026-09-25"
    assert {p.name for p in landed.glob("*-2026-09-24.json")} == {
        f"{m.lower()}-2026-09-24.json" for m in TRACKING_MEASURES
    }
    hustle = tmp_path / "landing/stats/leaguehustlestatsplayer/nba/2025-26/2026-09-25"
    assert (hustle / "hustle-2026-09-24.json").exists()
    # Dates follow the window, as games do: a window that ends before the game plans none.
    assert run_on(date(2026, 9, 26), until=date(2026, 9, 23)) == dict.fromkeys(tracking, 0)
    assert run_on(date(2026, 9, 26)) == tracking
    assert run_on(date(2026, 9, 27)) == dict.fromkeys(tracking, 0), "a settled date is left alone"


def test_wnba_run_makes_no_tracking_calls(tmp_path: Path) -> None:
    client, calls = counting_client()
    now = datetime(2026, 9, 25, 12, tzinfo=UTC)
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    summary = StatsIngestor(client, landing, StatsPlanner("wnba", "2026"), now=now).run()
    assert summary.ok, summary.failures
    assert calls["playergamelogs"] == 3
    assert "leaguedashptstats" not in calls and "leaguehustlestatsplayer" not in calls


def test_dry_run_plan_names_the_tracking_calls_for_the_nba_only() -> None:
    window = (date(2026, 1, 15), date(2026, 1, 15))
    nba = plan_lines(LandOptions("stats", "nba"), "2025-26", *window)
    assert any("playergamelogs key=usage-regular-season" in line for line in nba)
    assert any("playergamelogs key=misc-regular-season" in line for line in nba)
    per_date = [line for line in nba if "per game date" in line]
    assert len(per_date) == 1
    assert "leaguedashptstats passing" in per_date[0]
    assert "leaguehustlestatsplayer hustle" in per_date[0]
    wnba = plan_lines(LandOptions("stats", "wnba"), "2026", *window)
    assert any("usage-regular-season" in line for line in wnba)
    assert not any("per game date" in line for line in wnba)
