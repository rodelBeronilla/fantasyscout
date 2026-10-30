"""Sleeper's trending players: who fantasy managers are adding and dropping right now (NBA).

Sleeper lists the players added and dropped most across its leagues over a lookback window
(free for non-commercial use, with credit to Sleeper). WNBA trending is always empty, so this
runs for the NBA only. Sleeper names players by its own id, so its player directory lands too,
once a day as Sleeper asks, trimmed to the active players on a team and the fields that link
them to ours (name, Sleeper's ASCII search name, team, birth date). The trending lists land
under the day and the Eastern hour, the directory under the day.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from ingest.http import CircuitOpenError, ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

BASE = "https://api.sleeper.app/v1/players/{league}"
EASTERN = ZoneInfo("America/New_York")
LOOKBACK_HOURS = 24
LIMIT = 50
PLAYER_FIELDS = ("player_id", "full_name", "search_full_name", "team", "birth_date")


def trim_directory(body: bytes) -> list[dict[str, Any]]:
    """The active players on a team, with the fields that link them to the league's ids.

    The directory also lists each team as a player with no name; those are left out.
    """
    return [
        {k: p.get(k) for k in PLAYER_FIELDS}
        for p in json.loads(body).values()
        if isinstance(p, dict) and p.get("active") and p.get("team") and p.get("full_name")
    ]


@dataclass
class SleeperIngestor:
    """Lands Sleeper's trending adds and drops, and its player directory, into a run summary."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def land_into(self, summary: RunSummary) -> None:
        if self.league != "nba":
            return
        now = self.now or datetime.now(UTC)
        eastern = now.astimezone(EASTERN)
        try:
            self._land(
                summary,
                Scope("sleeper", "players", self.league, self.season),
                f"{eastern:%Y-%m-%d}",
                now,
            )
            self._land(
                summary,
                Scope("sleeper", "trending", self.league, self.season),
                f"{eastern:%Y-%m-%dT%H}",
                now,
            )
        except CircuitOpenError as exc:
            summary.aborted = str(exc)

    def _land(self, summary: RunSummary, scope: Scope, key: str, now: datetime) -> None:
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return
            base = BASE.format(league=self.league)
            if scope.endpoint == "players":
                url, params = base, {}
                response = self.client.get(url)
                if response.status_code != 200:
                    raise RuntimeError(f"HTTP {response.status_code}")
                body: dict[str, Any] = {"players": trim_directory(response.content)}
            else:
                url = f"{base}/trending"
                params = {"lookback_hours": str(LOOKBACK_HOURS), "limit": str(LIMIT)}
                body = {"lookback_hours": LOOKBACK_HOURS}
                for kind in ("add", "drop"):
                    response = self.client.get(f"{url}/{kind}", params=params)
                    if response.status_code != 200:
                        raise RuntimeError(f"{kind}: HTTP {response.status_code}")
                    body[kind] = response.json()
            result = self.landing.land(
                scope,
                key,
                json.dumps(body, ensure_ascii=False).encode(),
                url=url,
                params=params,
                status=200,
                fetched_at=now,
            )
            summary.record(result)
        except CircuitOpenError:
            raise
        except Exception as exc:  # Sleeper never fails the run
            summary.fail(scope.endpoint, key, exc)
