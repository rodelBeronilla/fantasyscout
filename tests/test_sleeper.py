from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.http import Throttle, ThrottledClient
from ingest.run import RunSummary
from ingest.sleeper import SleeperIngestor, trim_directory
from ingest.store import Landing, LocalBackend

DIRECTORY = {
    "2050": {
        "player_id": "2050",
        "full_name": "De'Andre Hunter",
        "search_full_name": "deandrehunter",
        "team": "SAC",
        "birth_date": "1997-12-02",
        "active": True,
        "injury_notes": None,
        "high_school": "Friends' Central (PA)",
        "kalshi_id": "c9d2b49b",
    },
    "9": {"player_id": "9", "full_name": "Free Agent", "team": None, "active": True},
    "10": {"player_id": "10", "full_name": "Retired", "team": "BOS", "active": False},
    "SAC": {"player_id": "SAC", "first_name": "Sacramento", "team": "SAC", "active": True},
}


def client_for(handler: object) -> ThrottledClient:
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def test_the_directory_keeps_active_players_on_a_team_and_the_linking_fields() -> None:
    assert trim_directory(json.dumps(DIRECTORY).encode()) == [
        {
            "player_id": "2050",
            "full_name": "De'Andre Hunter",
            "search_full_name": "deandrehunter",
            "team": "SAC",
            "birth_date": "1997-12-02",
        }
    ]


def test_trending_lands_each_hour_and_the_directory_once_a_day(tmp_path: Path) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path.endswith("/trending/add"):
            assert request.url.params["lookback_hours"] == "24"
            return httpx.Response(200, json=[{"player_id": "2050", "count": 26552}])
        if request.url.path.endswith("/trending/drop"):
            return httpx.Response(200, json=[{"player_id": "1801", "count": 7371}])
        return httpx.Response(200, json=DIRECTORY)

    client = client_for(handler)
    for hour in (13, 13, 23):  # 9 am, 9 am again, 7 pm Eastern
        now = datetime(2026, 10, 30, hour, tzinfo=UTC)
        summary = RunSummary("reports", "nba", "2026-27", now)
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        SleeperIngestor(client, landing, "nba", "2026-27", now=now).land_into(summary)
        landing.flush()
        assert not summary.failures
    assert seen.count("/v1/players/nba") == 1, "the directory once a day"
    assert seen.count("/v1/players/nba/trending/add") == 2, "trending once per hour"
    root = tmp_path / "landing/sleeper"
    trending = json.loads(next(root.rglob("2026-10-30T19.json")).read_text(encoding="utf-8"))
    assert trending["add"] == [{"player_id": "2050", "count": 26552}]
    assert trending["drop"][0]["player_id"] == "1801"
    directory = next((root / "players").rglob("2026-10-30.json")).read_text(encoding="utf-8")
    assert "kalshi" not in directory and "high_school" not in directory


def test_the_wnba_is_skipped_and_a_failure_is_recorded(tmp_path: Path) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(503)

    client = client_for(handler)
    now = datetime(2026, 10, 30, 13, tzinfo=UTC)
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    wnba = RunSummary("reports", "wnba", "2026", now)
    SleeperIngestor(client, landing, "wnba", "2026", now=now).land_into(wnba)
    assert calls == []
    nba = RunSummary("reports", "nba", "2026-27", now)
    SleeperIngestor(client, landing, "nba", "2026-27", now=now).land_into(nba)
    assert len(nba.failures) == 2
