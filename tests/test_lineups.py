from __future__ import annotations

import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.http import Throttle, ThrottledClient
from ingest.lineups import LineupsIngestor
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend

LINEUPS = (Path(__file__).parent / "fixtures" / "league" / "daily_lineups.json").read_bytes()


def client_for(handler) -> ThrottledClient:  # type: ignore[no-untyped-def]
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def run_at(tmp_path: Path, now: datetime, handler, league: str = "nba") -> RunSummary:  # type: ignore[no-untyped-def]
    summary = RunSummary("league", league, "2026-27", now)  # type: ignore[arg-type]
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    LineupsIngestor(client_for(handler), landing, league, "2026-27", now=now).land_into(summary)  # type: ignore[arg-type]
    landing.flush()
    return summary


def test_the_morning_and_evening_lineups_both_land_under_their_eastern_hour(tmp_path: Path) -> None:
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        assert request.headers["x-nba-stats-origin"] == "stats"
        return httpx.Response(200, content=LINEUPS)

    run_at(tmp_path, datetime(2026, 10, 29, 13, 20, tzinfo=UTC), handler)  # 9 am Eastern
    evening = run_at(tmp_path, datetime(2026, 10, 29, 23, 5, tzinfo=UTC), handler)  # 7 pm Eastern
    assert evening.ok and evening.landed == 1
    assert urls == ["https://stats.nba.com/js/data/leaders/00_daily_lineups_20261029.json"] * 2
    landed = sorted(
        p.name
        for p in (tmp_path / "landing/league/daily_lineups/nba/2026-27").rglob("*T*.json")
        if ".meta" not in p.name
    )
    assert landed == ["2026-10-29T09.json", "2026-10-29T19.json"]


def test_no_games_today_lands_nothing_and_the_wnba_asks_for_nothing(tmp_path: Path) -> None:
    quiet = run_at(tmp_path, datetime(2026, 10, 29, 13, tzinfo=UTC), lambda r: httpx.Response(404))
    assert quiet.ok and quiet.landed == 0

    def refuse(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the WNBA has no lineups file")

    assert run_at(tmp_path, datetime(2026, 7, 1, 13, tzinfo=UTC), refuse, league="wnba").landed == 0
