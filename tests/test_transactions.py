from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.http import League, Throttle, ThrottledClient
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend
from ingest.transactions import TransactionsIngestor, trim_movement

FIXTURES = Path(__file__).parent / "fixtures"
ESPN = (FIXTURES / "espn" / "transactions.json").read_bytes()
MOVEMENT = (FIXTURES / "league" / "player_movement.json").read_bytes()


def run(tmp_path: Path, league: League, now: datetime, calls: list[str]) -> RunSummary:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host + request.url.path)
        if request.url.host == "site.api.espn.com":
            assert request.url.params["limit"] == "100"
            return httpx.Response(200, content=ESPN)
        assert request.headers["x-nba-stats-origin"] == "stats"
        return httpx.Response(200, content=MOVEMENT)

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    summary = RunSummary("league", league, "2026-27", now)
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    TransactionsIngestor(client, landing, league, "2026-27", now=now).land_into(summary)
    landing.flush()
    return summary


def test_the_movement_feed_is_trimmed_to_the_recent_moves() -> None:
    trimmed = json.loads(trim_movement(MOVEMENT, "2026-10-28"))
    rows = trimmed["NBA_Player_Movement"]["rows"]
    assert rows and all(r["TRANSACTION_DATE"] >= "2026-10-28" for r in rows)
    assert trimmed["since"] == "2026-10-28"
    assert trimmed["NBA_Player_Movement"]["columns"] is not None


def test_the_nba_lands_both_feeds_once_a_day_and_the_wnba_only_espn(tmp_path: Path) -> None:
    now = datetime(2026, 10, 29, 13, tzinfo=UTC)
    calls: list[str] = []
    first = run(tmp_path, "nba", now, calls)
    assert first.ok and first.landed == 2
    assert calls == [
        "site.api.espn.com/apis/site/v2/sports/basketball/nba/transactions",
        "stats.nba.com/js/data/playermovement/NBA_Player_Movement.json",
    ]
    calls.clear()
    again = run(tmp_path, "nba", now, calls)
    assert again.ok and again.skipped == 2 and calls == []
    wnba_calls: list[str] = []
    wnba = run(tmp_path, "wnba", now, wnba_calls)
    assert wnba.landed == 1 and wnba_calls == [
        "site.api.espn.com/apis/site/v2/sports/basketball/wnba/transactions"
    ]


def test_the_movement_history_lands_every_move_once(tmp_path: Path) -> None:
    # #794: the daily run keeps 180 days; a history run keeps the whole file, once.
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, content=MOVEMENT)

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    for day in (7, 8):
        now = datetime(2026, 11, day, 13, tzinfo=UTC)
        summary = RunSummary("league", "nba", "2026-27", now)
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        TransactionsIngestor(client, landing, "nba", "2026-27", now=now).land_movement_history(
            summary
        )
        landing.flush()
    assert calls == ["/js/data/playermovement/NBA_Player_Movement.json"], "once"
    [landed] = [
        f for f in (tmp_path / "landing/league/player_movement/nba/2026-27").rglob("history.json")
    ]
    rows = json.loads(landed.read_text(encoding="utf-8"))["NBA_Player_Movement"]["rows"]
    every = json.loads(MOVEMENT)["NBA_Player_Movement"]["rows"]
    assert len(rows) == len(every)
