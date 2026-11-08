from __future__ import annotations

import json
import random
from datetime import UTC, date, datetime
from pathlib import Path

import httpx

from ingest.espn_fantasy import EspnFantasyIngestor, draft_order_due, espn_year, trim_players
from ingest.http import Throttle, ThrottledClient
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend

FULL_PLAYER = {
    "id": 3112335,
    "fullName": "Nikola Jokic",
    "proTeamId": 7,
    "defaultPositionId": 5,
    "ownership": {"percentOwned": 99.93, "averageDraftPosition": 1.69, "percentStarted": 95.98},
    "draftRanksByRankType": {"STANDARD": {"rank": 1, "auctionValue": 65}, "ROTO": {"rank": 1}},
    "seasonOutlook": "Licensed editorial that must not be landed.",
    "stats": [{"id": "x", "stats": {"0": 27.1}}],
}


def test_espn_names_an_nba_season_by_the_year_it_ends() -> None:
    assert espn_year("nba", "2026-27") == "2027"
    assert espn_year("wnba", "2026") == "2026"


def test_a_player_keeps_the_market_and_loses_the_outlook_and_the_stats() -> None:
    [player] = trim_players(json.dumps([FULL_PLAYER]).encode())
    assert player["ownership"]["averageDraftPosition"] == 1.69
    assert player["draftRanks"] == {"STANDARD": 1, "ROTO": 1}
    assert "seasonOutlook" not in player and "stats" not in player


def test_the_market_lands_once_a_day_with_every_player_asked_for(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=json.dumps([FULL_PLAYER]).encode())

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    now = datetime(2026, 10, 30, 9, tzinfo=UTC)
    for _ in range(2):
        summary = RunSummary("league", "nba", "2026-27", now)
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        EspnFantasyIngestor(client, landing, "nba", "2026-27", now=now).land_into(summary)
        landing.flush()
    assert len(seen) == 1, "once a day"
    assert seen[0].url.path == "/apis/v3/games/fba/seasons/2027/players"
    assert json.loads(seen[0].headers["X-Fantasy-Filter"]) == {"players": {"limit": 5000}}
    landed = next((tmp_path / "landing/espn/fantasy_players/nba/2026-27").rglob("2026-10-30.json"))
    body = landed.read_text(encoding="utf-8")
    assert "Licensed editorial" not in body
    assert json.loads(body)["players"][0]["fullName"] == "Nikola Jokic"


def test_a_past_seasons_market_lands_once_under_its_own_endpoint(tmp_path: Path) -> None:
    # #786: a history run must never land where the board reads the latest market, and a second
    # run, even on another day, asks for nothing.
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=json.dumps([FULL_PLAYER]).encode())

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    for day in (7, 8):
        now = datetime(2026, 11, day, 9, tzinfo=UTC)
        summary = RunSummary("espn", "nba", "2018-19", now)
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        EspnFantasyIngestor(client, landing, "nba", "2018-19", now=now, history=True).land_into(
            summary
        )
        landing.flush()
    assert len(seen) == 1, "once per season"
    assert seen[0].url.path == "/apis/v3/games/fba/seasons/2019/players"
    assert not (tmp_path / "landing/espn/fantasy_players").exists()
    [landed] = (tmp_path / "landing/espn/fantasy_adp/nba/2018-19").rglob("preseason.json")
    assert (
        json.loads(landed.read_text(encoding="utf-8"))["players"][0]["fullName"] == "Nikola Jokic"
    )


def test_the_draft_order_is_due_from_the_eve_of_the_first_regular_season_game() -> None:
    # #847: tomorrow's scoreboard has the first game, so the drafts are done; a season under way
    # (a game in the past week) is due too, for a run that missed the eve. Nothing is due while
    # the only regular-season games are further ahead, or there are none.
    today = date(2026, 10, 20)
    assert draft_order_due({date(2026, 10, 21), date(2026, 10, 22)}, today)
    assert draft_order_due({date(2026, 10, 15)}, today)
    assert not draft_order_due({date(2026, 10, 22), date(2026, 10, 27)}, today)
    assert not draft_order_due(set(), today)


def test_the_live_seasons_draft_order_lands_once_even_on_a_full_refresh(tmp_path: Path) -> None:
    # #847: the daily run lands the season being played under fantasy_adp, as a history run
    # would, and a later full refresh does not replace the order as it stood at tip-off.
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=json.dumps([FULL_PLAYER]).encode())

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    for day, full_refresh in ((20, False), (21, True)):
        now = datetime(2026, 10, day, 9, tzinfo=UTC)
        summary = RunSummary("espn", "nba", "2026-27", now)
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date(), full_refresh=full_refresh)
        EspnFantasyIngestor(client, landing, "nba", "2026-27", now=now, keep=True).land_into(
            summary
        )
        landing.flush()
        assert summary.ok, summary.failures
    assert len(seen) == 1, "once per season"
    assert seen[0].url.path == "/apis/v3/games/fba/seasons/2027/players"
    assert not (tmp_path / "landing/espn/fantasy_players").exists()
    [landed] = (tmp_path / "landing/espn/fantasy_adp/nba/2026-27").rglob("preseason.json")
    assert landed.parent.name == "2026-10-20"
