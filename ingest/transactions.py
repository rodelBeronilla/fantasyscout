"""Transactions: signings, waivers, trades, two-way and 10-day deals, G League assignments.

Two sources, landed by the reports run once a day:

- ESPN's transactions feed, both leagues: one line per team and day, as ESPN writes it
  ("Signed C Lawson Lovering to a two-way contract."), the latest hundred.
- The NBA's player movement feed (stats.nba.com/js/data/playermovement), NBA only: one row per
  move with the league's player and team ids. The file holds every move since 2015, about 4 MB;
  only the last 180 days are landed (the payload says from when), which is all the site uses.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from ingest.http import CircuitOpenError, ThrottledClient, stats_headers
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/{league}/transactions"
MOVEMENT_URL = "https://stats.nba.com/js/data/playermovement/NBA_Player_Movement.json"
MOVEMENT_DAYS = 180


def trim_movement(body: bytes, since: str) -> bytes:
    """The movement file with only the rows on or after ``since`` (YYYY-MM-DD)."""
    doc = json.loads(body)
    feed = doc.get("NBA_Player_Movement") or {}
    rows = [r for r in feed.get("rows") or [] if str(r.get("TRANSACTION_DATE", "")) >= since]
    trimmed = {
        "NBA_Player_Movement": {"columns": feed.get("columns"), "rows": rows},
        "since": since,
    }
    return json.dumps(trimmed, ensure_ascii=False).encode("utf-8")


@dataclass
class TransactionsIngestor:
    """Lands today's transactions into an existing run summary."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def _land(self, summary: RunSummary, scope: Scope, key: str, url: str, fetch) -> None:  # type: ignore[no-untyped-def]
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return
            status, body = fetch()
            if status != 200:
                summary.fail(scope.endpoint, key, RuntimeError(f"HTTP {status}"))
                return
            result = self.landing.land(
                scope, key, body, url=url, params={}, status=200, fetched_at=self._clock()
            )
            summary.record(result)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # transactions never fail the run
            summary.fail(scope.endpoint, key, exc)

    def _clock(self) -> datetime:
        return self.now or datetime.now(UTC)

    def land_into(self, summary: RunSummary) -> None:
        today = self._clock().date()
        key = today.isoformat()
        espn_url = ESPN_URL.format(league=self.league)

        def espn() -> tuple[int, bytes]:
            response = self.client.get(espn_url, params={"limit": "100"})
            return response.status_code, response.content

        self._land(
            summary, Scope("espn", "transactions", self.league, self.season), key, espn_url, espn
        )
        if self.league != "nba":
            return

        def movement() -> tuple[int, bytes]:
            response = self.client.get(MOVEMENT_URL, headers=stats_headers("nba"))
            if response.status_code != 200:
                return response.status_code, b""
            since = (today - timedelta(days=MOVEMENT_DAYS)).isoformat()
            return 200, trim_movement(response.content, since)

        self._land(
            summary,
            Scope("league", "player_movement", self.league, self.season),
            key,
            MOVEMENT_URL,
            movement,
        )
