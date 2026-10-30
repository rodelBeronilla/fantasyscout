from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.espn_fantasy import EspnFantasyIngestor, espn_year, trim_players
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
