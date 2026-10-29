"""The NBA's daily starting lineups: who starts each of today's games and who is inactive.

stats.nba.com publishes one JSON file per day for the league's games. For each team it lists
every player with the league's player id, a position for the five starters (blank for the
bench), a lineup status (Expected until the team confirms it, then Confirmed, about half an hour
before tip-off) and a roster status (Active or Inactive). The WNBA has no such file.

A run lands the file under the day and the Eastern hour of the run, so the morning's expected
lineups and the evening's confirmed ones are both kept; silver reads the latest.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from ingest.http import CircuitOpenError, ThrottledClient, stats_headers
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

SOURCE = "league"
ENDPOINT = "daily_lineups"
EASTERN = ZoneInfo("America/New_York")
URL = "https://stats.nba.com/js/data/leaders/00_daily_lineups_{day}.json"


@dataclass
class LineupsIngestor:
    """Lands today's lineups file (NBA only) into an existing run summary."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def land_into(self, summary: RunSummary) -> None:
        if self.league != "nba":
            return
        local = (self.now or datetime.now(UTC)).astimezone(EASTERN)
        url = URL.format(day=f"{local:%Y%m%d}")
        key = f"{local:%Y-%m-%dT%H}"
        scope = Scope(SOURCE, ENDPOINT, self.league, self.season)
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return
            response = self.client.get(url, headers=stats_headers("nba"))
            if response.status_code == 404:
                return  # no games today
            if response.status_code != 200:
                summary.fail(ENDPOINT, key, RuntimeError(f"HTTP {response.status_code}"))
                return
            games = json.loads(response.content).get("games") or []
            if not games:
                return
            result = self.landing.land(
                scope,
                key,
                response.content,
                url=url,
                params={},
                status=200,
                fetched_at=self.now or datetime.now(UTC),
            )
            summary.record(result)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # the lineups never fail the run
            summary.fail(ENDPOINT, key, exc)
