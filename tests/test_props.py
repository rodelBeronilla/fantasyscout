from __future__ import annotations

import json
import random
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from ingest.http import Throttle, ThrottledClient
from ingest.props import (
    EspnPropsIngestor,
    OddsApiIngestor,
    american,
    pair_outcomes,
    snapshot_key,
    trim_prop_bets,
    upcoming_events,
)
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend

FIXTURES = Path(__file__).parent / "fixtures"
# 10:59 am Eastern on a game day; the fixtures were captured then.
MORNING = datetime(2026, 10, 30, 14, 59, tzinfo=UTC)
EVENING = datetime(2026, 10, 30, 23, 0, tzinfo=UTC)


def fixture(*parts: str) -> bytes:
    return FIXTURES.joinpath(*parts).read_bytes()


def client_for(handler: Callable[[httpx.Request], httpx.Response]) -> ThrottledClient:
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def test_prices_and_snapshot_keys() -> None:
    assert american("-106") == -106
    assert american("+101") == 101
    assert american(150) == 150
    assert american("EVEN") == 100
    assert american(None) is None
    assert snapshot_key(MORNING) == "2026-10-30T10"
    assert snapshot_key(EVENING) == "2026-10-30T19"


def test_only_events_that_have_not_started_are_upcoming() -> None:
    events = upcoming_events(fixture("espn", "scoreboard_upcoming.json"))
    assert [e.event_id for e in events] == ["401909277", "401909278"]
    assert events[0].commence_at == "2026-10-30T23:00:00+00:00"
    assert (events[0].home_team_id, events[0].away_team_id) == ("27", "30")
    finished = json.loads(fixture("espn", "scoreboard.json"))
    assert upcoming_events(json.dumps(finished).encode()) == []


def test_espn_totals_split_into_over_and_under_and_the_rest_is_dropped() -> None:
    items = json.loads(fixture("espn", "prop_bets_page1.json"))["items"]
    props = trim_prop_bets(items)
    # Three totals for one player; milestones, a game line and a yes-only prop are dropped.
    assert [p["prop_type"] for p in props] == ["Total Points", "Total Assists", "Total Rebounds"]
    points = props[0]
    assert points == {
        "athlete_id": "6583",
        "type_id": "1",
        "prop_type": "Total Points",
        "line": 21.5,
        "open_line": 21.5,
        "over_odds": -106,
        "under_odds": -120,
        "over_open_odds": -115,
        "under_open_odds": -111,
        "last_updated": "2026-10-30T14:09:00+00:00",
    }
    # A total quoted only once cannot be told apart and is left out.
    assert trim_prop_bets(items[:1]) == []


def test_espn_props_page_through_and_land_per_event_and_eastern_hour(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    empty_day = json.dumps({"events": []}).encode()

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if path.endswith("/scoreboard"):
            today = request.url.params["dates"] == "20261030"
            return httpx.Response(
                200, content=fixture("espn", "scoreboard_upcoming.json") if today else empty_day
            )
        if "/events/401909277/" in path:
            page = request.url.params["page"]
            return httpx.Response(200, content=fixture("espn", f"prop_bets_page{page}.json"))
        return httpx.Response(404, json={"error": {"message": "No propBets found", "code": 404}})

    client = client_for(handler)
    for _ in range(2):  # the second run in the same hour fetches nothing new
        summary = RunSummary("reports", "nba", "2026-27", MORNING)
        landing = Landing(LocalBackend(tmp_path), ingest_date=MORNING.date())
        EspnPropsIngestor(client, landing, "nba", "2026-27", now=MORNING).land_into(summary)
        landing.flush()
    prop_calls = [r for r in seen if r.url.path.endswith("/propBets")]
    assert [r.url.params["page"] for r in prop_calls] == [
        "1",
        "2",
        "1",
        "1",
    ]  # 277 twice-paged, 278 missing, then 278 again
    assert prop_calls[0].url.path == (
        "/v2/sports/basketball/leagues/nba/events/401909277/competitions/401909277/odds/100/propBets"
    )
    assert prop_calls[0].url.params["limit"] == "1000"
    assert summary.skipped == 1 and summary.missing and not summary.failures

    landed = next(
        (tmp_path / "landing/espn/prop_bets/nba/2026-27").rglob("401909277-2026-10-30T10.json")
    )
    doc = json.loads(landed.read_text(encoding="utf-8"))
    assert doc["commence_at"] == "2026-10-30T23:00:00+00:00" and doc["game_date_et"] == "2026-10-30"
    assert doc["items_at_source"] == 21
    assert {p["athlete_id"] for p in doc["props"]} == {"6583", "3032979"}  # both pages
    assert all(p["over_odds"] and p["under_odds"] for p in doc["props"])


def test_morning_and_evening_lines_are_both_kept(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/scoreboard"):
            return httpx.Response(200, content=fixture("espn", "scoreboard_upcoming.json"))
        page = request.url.params["page"]
        return httpx.Response(200, content=fixture("espn", f"prop_bets_page{page}.json"))

    client = client_for(handler)
    for now in (MORNING, EVENING):
        summary = RunSummary("reports", "nba", "2026-27", now)
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        EspnPropsIngestor(client, landing, "nba", "2026-27", now=now).land_into(summary)
        landing.flush()
    names = sorted(p.name for p in (tmp_path / "landing/espn/prop_bets").rglob("401909277-*.json"))
    assert names == [
        "401909277-2026-10-30T10.json",
        "401909277-2026-10-30T10.meta.json",
        "401909277-2026-10-30T19.json",
        "401909277-2026-10-30T19.meta.json",
    ]


def test_wnba_props_use_the_wnba_feed_and_land_even_without_totals(tmp_path: Path) -> None:
    scoreboard = json.loads(fixture("espn", "scoreboard_upcoming.json"))
    scoreboard["events"] = scoreboard["events"][:1]
    scoreboard["events"][0]["id"] = "401857215"
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/scoreboard"):
            return httpx.Response(200, content=json.dumps(scoreboard).encode())
        return httpx.Response(200, content=fixture("espn", "prop_bets_wnba.json"))

    summary = RunSummary("reports", "wnba", "2026", MORNING)
    landing = Landing(LocalBackend(tmp_path), ingest_date=MORNING.date())
    EspnPropsIngestor(client_for(handler), landing, "wnba", "2026", now=MORNING).land_into(summary)
    landing.flush()
    assert "/apis/site/v2/sports/basketball/wnba/scoreboard" in paths
    assert any("/leagues/wnba/events/401857215/" in p for p in paths)
    doc = json.loads(
        next((tmp_path / "landing/espn/prop_bets/wnba/2026").rglob("401857215-*.json")).read_text(
            "utf-8"
        )
    )
    assert doc["items_at_source"] == 8 and doc["props"] == []  # milestones and game lines only


def test_a_failed_scoreboard_is_recorded_and_does_not_raise(tmp_path: Path) -> None:
    summary = RunSummary("reports", "nba", "2026-27", MORNING)
    landing = Landing(LocalBackend(tmp_path), ingest_date=MORNING.date())
    client = client_for(lambda _: httpx.Response(500))
    EspnPropsIngestor(client, landing, "nba", "2026-27", now=MORNING).land_into(summary)
    assert [f.endpoint for f in summary.failures] == ["prop_bets", "prop_bets"]


def test_odds_api_without_a_key_is_skipped_not_failed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    seen: list[httpx.Request] = []
    client = client_for(lambda r: seen.append(r) or httpx.Response(500))  # type: ignore[func-returns-value]
    summary = RunSummary("reports", "nba", "2026-27", MORNING)
    landing = Landing(LocalBackend(tmp_path), ingest_date=MORNING.date())
    OddsApiIngestor(client, landing, "nba", "2026-27", "", now=MORNING).land_into(summary)
    assert seen == []
    assert summary.skipped == 1 and summary.ok
    assert "ODDS_API_KEY is not set" in capsys.readouterr().out


def test_odds_api_pairs_outcomes_by_bookmaker_market_player_and_line() -> None:
    props = pair_outcomes(json.loads(fixture("odds_api", "event_odds.json")))
    assert props[0] == {
        "bookmaker": "draftkings",
        "market": "player_points",
        "player_name": "Sample Guard",
        "line": 21.5,
        "over_odds": -115,
        "under_odds": -105,
        "last_updated": "2026-10-30T14:58:12+00:00",
    }
    one_sided = [p for p in props if p["line"] == 25.5]
    assert one_sided == [{**one_sided[0], "over_odds": 135, "under_odds": None}]


def test_odds_api_calls_once_per_event_in_the_window_and_logs_credits(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/events"):
            return httpx.Response(200, content=fixture("odds_api", "events.json"))
        headers = {"x-requests-remaining": "480", "x-requests-used": "20", "x-requests-last": "7"}
        return httpx.Response(200, content=fixture("odds_api", "event_odds.json"), headers=headers)

    client = client_for(handler)
    for _ in range(2):  # the second run in the same hour spends nothing
        summary = RunSummary("reports", "nba", "2026-27", MORNING)
        landing = Landing(LocalBackend(tmp_path), ingest_date=MORNING.date())
        OddsApiIngestor(client, landing, "nba", "2026-27", "secret-key", now=MORNING).land_into(
            summary
        )
        landing.flush()
    odds_calls = [r for r in seen if r.url.path.endswith("/odds")]
    # Two events start within 36 hours; the third, on 2 November, waits.
    assert [r.url.path.split("/")[-2] for r in odds_calls] == [
        "c1a2b3d4e5f60718293a4b5c6d7e8f90",
        "d2b3c4d5e6f708192a3b4c5d6e7f8091",
    ]
    params = odds_calls[0].url.params
    assert odds_calls[0].url.path.startswith("/v4/sports/basketball_nba/events/")
    assert params["regions"] == "us" and params["oddsFormat"] == "american"
    assert (
        params["markets"].split(",")[0] == "player_points"
        and len(params["markets"].split(",")) == 7
    )
    assert "commenceTimeFrom" in seen[0].url.params
    assert "remaining 480" in capsys.readouterr().out

    for meta in (tmp_path / "landing/odds_api").rglob("*.meta.json"):
        assert "secret-key" not in meta.read_text(encoding="utf-8")
    landed = next(
        (tmp_path / "landing/odds_api/player_props/nba/2026-27").rglob(
            "c1a2b3d4e5f60718293a4b5c6d7e8f90-2026-10-30T10.json"
        )
    )
    doc = json.loads(landed.read_text(encoding="utf-8"))
    assert doc["home_team"] == "Washington Wizards" and doc["game_date_et"] == "2026-10-30"
    assert len(doc["props"]) == 5


def test_odds_api_stops_calling_when_credits_run_short(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/events"):
            return httpx.Response(200, content=fixture("odds_api", "events.json"))
        calls.append(request.url.path)
        return httpx.Response(
            200,
            content=fixture("odds_api", "event_odds.json"),
            headers={"x-requests-remaining": "5"},
        )

    summary = RunSummary("reports", "wnba", "2026", MORNING)
    landing = Landing(LocalBackend(tmp_path), ingest_date=MORNING.date())
    OddsApiIngestor(client_for(handler), landing, "wnba", "2026", "k", now=MORNING).land_into(
        summary
    )
    assert len(calls) == 1 and calls[0].startswith("/v4/sports/basketball_wnba/")
    assert summary.landed == 1 and summary.skipped == 1 and summary.ok
    assert "fewer than one call costs" in capsys.readouterr().out


def test_an_odds_api_error_is_a_failure(tmp_path: Path) -> None:
    summary = RunSummary("reports", "nba", "2026-27", MORNING)
    landing = Landing(LocalBackend(tmp_path), ingest_date=MORNING.date())
    client = client_for(lambda _: httpx.Response(401, json={"message": "Invalid api key"}))
    OddsApiIngestor(client, landing, "nba", "2026-27", "bad", now=MORNING).land_into(summary)
    assert [(f.endpoint, f.key) for f in summary.failures] == [("player_props", "events")]
    assert "bad" not in summary.failures[0].reason
