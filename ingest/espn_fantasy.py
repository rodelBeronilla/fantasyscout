"""The fantasy market from ESPN's fantasy game: where players go in drafts, and how widely they
are rostered, for both leagues (ESPN runs fantasy WNBA as well as NBA).

ESPN's fantasy API returns every player with full stat lines and written outlooks, about 26 MB
for the NBA, and ignores requests to narrow it. A run fetches it once a day and lands only what
the platform uses: the player, team and position, the share of ESPN leagues that roster and start
him, the average draft position and auction value, and ESPN's own draft ranks. The written
outlook (licensed editorial) is never landed. The site publishes ranks and ownership buckets
derived from these, not ESPN's numbers (ADR 0008).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ingest.http import CircuitOpenError, ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/{game}/seasons/{year}/players"
GAME = {"nba": "fba", "wnba": "wfba"}
FILTER = json.dumps({"players": {"limit": 5000}})
OWNERSHIP_KEYS = (
    "percentOwned",
    "percentStarted",
    "averageDraftPosition",
    "auctionValueAverage",
    "percentChange",
)


def espn_year(league: League, season: str) -> str:
    """ESPN names an NBA season by the year it ends (2026-27 is 2027); the WNBA by its year."""
    return str(int(season[:4]) + 1) if league == "nba" else season[:4]


def trim_players(body: bytes) -> list[dict[str, Any]]:
    """Each player reduced to the fields the platform uses."""
    doc = json.loads(body)
    rows = doc if isinstance(doc, list) else doc.get("players") or []
    out: list[dict[str, Any]] = []
    for p in rows:
        ownership = p.get("ownership") or {}
        ranks = p.get("draftRanksByRankType") or {}
        out.append(
            {
                "id": p.get("id"),
                "fullName": p.get("fullName"),
                "proTeamId": p.get("proTeamId"),
                "defaultPositionId": p.get("defaultPositionId"),
                "ownership": {k: ownership.get(k) for k in OWNERSHIP_KEYS},
                "draftRanks": {k: (v or {}).get("rank") for k, v in ranks.items()},
            }
        )
    return out


@dataclass
class EspnFantasyIngestor:
    """Lands today's fantasy market for one league into an existing run summary."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def land_into(self, summary: RunSummary) -> None:
        now = self.now or datetime.now(UTC)
        key = now.date().isoformat()
        game, year = GAME[self.league], espn_year(self.league, self.season)
        url = URL.format(game=game, year=year)
        scope = Scope("espn", "fantasy_players", self.league, self.season)
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return
            response = self.client.get(
                url,
                params={"scoringPeriodId": "0", "view": "kona_player_info"},
                # Without a limit ESPN returns its first page only (the filter's sort is ignored).
                headers={"Accept": "application/json", "X-Fantasy-Filter": FILTER},
            )
            if response.status_code != 200:
                summary.fail("fantasy_players", key, RuntimeError(f"HTTP {response.status_code}"))
                return
            payload = {"game": game, "season": year, "players": trim_players(response.content)}
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            result = self.landing.land(
                scope,
                key,
                body,
                url=url,
                params={"view": "kona_player_info"},
                status=200,
                fetched_at=now,
            )
            summary.record(result)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # the market never fails the run
            summary.fail("fantasy_players", key, exc)
