"""League stats API ingestor: stats.wnba.com and stats.nba.com.

The two hosts share one endpoint family and differ by ``LeagueID`` (``10`` WNBA, ``00``
NBA) and by the season label (``2026`` vs ``2025-26``). Every request is planned first
(``Request`` objects with a stable landing key), then fetched through the shared throttled
client and handed to the landing store untouched.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Literal

from ingest.http import ThrottledClient, stats_headers
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, LandResult, Scope

SOURCE = "stats"
HOSTS: dict[League, str] = {
    "wnba": "https://stats.wnba.com/stats",
    "nba": "https://stats.nba.com/stats",
}
LEAGUE_ID: dict[League, str] = {"wnba": "10", "nba": "00"}

SeasonType = Literal["Regular Season", "Playoffs"]

# shotchartdetail refuses requests that omit any of these, even when empty.
_SHOTCHART_DEFAULTS = {
    "AheadBehind": "",
    "ClutchTime": "",
    "DateFrom": "",
    "DateTo": "",
    "EndPeriod": "",
    "EndRange": "",
    "GameSegment": "",
    "LastNGames": "0",
    "Location": "",
    "Month": "0",
    "OpponentTeamID": "0",
    "Outcome": "",
    "Period": "0",
    "PlayerPosition": "",
    "PointDiff": "",
    "Position": "",
    "RangeType": "",
    "RookieYear": "",
    "SeasonSegment": "",
    "StartPeriod": "",
    "StartRange": "",
    "VsConference": "",
    "VsDivision": "",
}


def season_label(league: League, start_year: int) -> str:
    """``2026`` for the WNBA (a calendar-year league), ``2025-26`` for the NBA."""
    if league == "wnba":
        return str(start_year)
    return f"{start_year}-{(start_year + 1) % 100:02d}"


def _slug(season_type: SeasonType) -> str:
    return season_type.lower().replace(" ", "-")


@dataclass(frozen=True)
class Request:
    """One planned call: the endpoint, its query and the key it lands under."""

    endpoint: str
    key: str
    params: dict[str, str] = field(default_factory=dict)

    def url(self, league: League) -> str:
        return f"{HOSTS[league]}/{self.endpoint}"


@dataclass(frozen=True)
class GameRef:
    game_id: str
    game_date: date
    team_ids: frozenset[str]


class StatsPlanner:
    """Builds the request list for one league-season. Pure; no network."""

    def __init__(self, league: League, season: str, season_type: SeasonType = "Regular Season"):
        self.league = league
        self.season = season
        self.season_type = season_type
        self.league_id = LEAGUE_ID[league]

    def season_requests(self) -> list[Request]:
        return [
            Request(
                "scheduleleaguev2",
                "season",
                {"LeagueID": self.league_id, "Season": self.season},
            ),
            Request(
                "commonallplayers",
                "season",
                {"LeagueID": self.league_id, "Season": self.season, "IsOnlyCurrentSeason": "1"},
            ),
            self.gamelog_request(),
        ]

    def gamelog_request(self) -> Request:
        return Request(
            "leaguegamelog",
            f"team-{_slug(self.season_type)}",
            {
                "Counter": "1000",
                "DateFrom": "",
                "DateTo": "",
                "Direction": "DESC",
                "LeagueID": self.league_id,
                "PlayerOrTeam": "T",
                "Season": self.season,
                "SeasonType": self.season_type,
                "Sorter": "DATE",
            },
        )

    def game_requests(self, game_id: str) -> list[Request]:
        v3 = {
            "GameID": game_id,
            "LeagueID": self.league_id,
            "startPeriod": "0",
            "endPeriod": "0",
            "startRange": "0",
            "endRange": "0",
            "rangeType": "0",
        }
        return [
            Request("boxscoretraditionalv3", game_id, v3),
            Request("boxscoreadvancedv3", game_id, v3),
            Request(
                "playbyplayv3",
                game_id,
                {"GameID": game_id, "StartPeriod": "0", "EndPeriod": "14"},
            ),
            Request(
                "shotchartdetail",
                game_id,
                {
                    **_SHOTCHART_DEFAULTS,
                    "ContextMeasure": "FGA",
                    "GameID": game_id,
                    "LeagueID": self.league_id,
                    "PlayerID": "0",
                    "TeamID": "0",
                    "Season": self.season,
                    "SeasonType": self.season_type,
                },
            ),
        ]

    def roster_requests(self, team_ids: Iterable[str]) -> list[Request]:
        return [
            Request(
                "commonteamroster",
                team_id,
                {"TeamID": team_id, "Season": self.season, "LeagueID": self.league_id},
            )
            for team_id in sorted(set(team_ids))
        ]


def parse_result_set(payload: bytes, name: str | None = None) -> list[dict[str, object]]:
    """Rows of one ``resultSets`` entry as dicts (the first set when ``name`` is None)."""
    doc = json.loads(payload)
    sets = doc.get("resultSets") or []
    chosen = None
    for rs in sets:
        if name is None or rs.get("name") == name:
            chosen = rs
            break
    if chosen is None:
        return []
    headers = chosen.get("headers") or []
    rows: list[dict[str, object]] = []
    for row in chosen.get("rowSet") or []:
        rows.append(dict(zip(headers, row, strict=False)))
    return rows


def games_in_window(
    gamelog_payload: bytes, *, since: date | None = None, until: date | None = None
) -> list[GameRef]:
    """Distinct games from a team ``leaguegamelog`` payload, filtered to [since, until]."""
    by_game: dict[str, tuple[date, set[str]]] = {}
    for row in parse_result_set(gamelog_payload):
        game_id = str(row.get("GAME_ID", ""))
        raw_date = str(row.get("GAME_DATE", ""))
        if not game_id or not raw_date:
            continue
        game_date = date.fromisoformat(raw_date[:10])
        if since is not None and game_date < since:
            continue
        if until is not None and game_date > until:
            continue
        _, teams = by_game.setdefault(game_id, (game_date, set()))
        teams.add(str(row.get("TEAM_ID", "")))
    return [
        GameRef(game_id, game_date, frozenset(t for t in teams if t))
        for game_id, (game_date, teams) in sorted(by_game.items(), key=lambda kv: (kv[1][0], kv[0]))
    ]


class StatsIngestor:
    """Fetches planned requests and lands them. A failed request is recorded, never raised."""

    def __init__(
        self,
        client: ThrottledClient,
        landing: Landing,
        planner: StatsPlanner,
        *,
        now: datetime | None = None,
    ) -> None:
        self.client = client
        self.landing = landing
        self.planner = planner
        self._now = now

    def _clock(self) -> datetime:
        return self._now or datetime.now(UTC)

    def fetch(self, request: Request) -> tuple[LandResult | None, bytes | None]:
        """Land one request. Returns (result, body); result is None when already landed today."""
        league = self.planner.league
        scope = Scope(SOURCE, request.endpoint, league, self.planner.season)
        if self.landing.already_landed_today(scope, request.key):
            return None, self.landing.read_latest(scope, request.key)
        url = request.url(league)
        response = self.client.get(url, params=request.params, headers=stats_headers(league))
        if response.status_code != 200:
            msg = f"HTTP {response.status_code}"
            raise RuntimeError(msg)
        result = self.landing.land(
            scope,
            request.key,
            response.content,
            url=url,
            params=dict(request.params),
            status=response.status_code,
            fetched_at=self._clock(),
        )
        return result, response.content

    def _try(self, request: Request, summary: RunSummary) -> bytes | None:
        try:
            result, body = self.fetch(request)
        except Exception as exc:  # a failed request never fails the run
            summary.fail(request.endpoint, request.key, exc)
            return None
        summary.record(result)
        return body

    def run(self, *, since: date | None = None, until: date | None = None) -> RunSummary:
        summary = RunSummary(SOURCE, self.planner.league, self.planner.season, self._clock())
        gamelog = self.planner.gamelog_request()
        gamelog_body: bytes | None = None
        for request in self.planner.season_requests():
            body = self._try(request, summary)
            if request == gamelog:
                gamelog_body = body
        if gamelog_body is None:
            # The game log failed, so there is nothing to plan games from.
            for failure in self.landing.flush():
                summary.fail(failure.endpoint, failure.key, failure.error)
            return summary
        games = games_in_window(gamelog_body, since=since, until=until)
        summary.games = len(games)
        team_ids: set[str] = set()
        for game in games:
            team_ids |= game.team_ids
            for request in self.planner.game_requests(game.game_id):
                self._try(request, summary)
        for request in self.planner.roster_requests(team_ids):
            self._try(request, summary)
        for failure in self.landing.flush():
            summary.fail(failure.endpoint, failure.key, failure.error)
        return summary
