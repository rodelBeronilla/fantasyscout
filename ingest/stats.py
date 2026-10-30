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

from ingest.http import CircuitOpenError, ThrottledClient, stats_headers
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
# "game": one shotchartdetail call per game (small daily windows).
# "team-season": one call per team for the whole season (backfills: 10-40x fewer requests,
# same payload shape, so bronze and silver are unchanged; silver keeps the latest landing per shot).
ShotsScope = Literal["game", "team-season"]

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

# Season-level player game logs beyond the advanced line: each player's share of the team's
# box score (Usage) and the scoring context, fouls drawn and blocks against (Misc). One call per
# season and season type each, both leagues.
GAMELOG_MEASURES = ("Advanced", "Usage", "Misc")

# Player tracking (leaguedashptstats) and hustle (leaguehustlestatsplayer) have no per-game or
# season-of-games form, so they are fetched one game date at a time (DateFrom = DateTo): one row
# per player who played that day. The WNBA host answers with no rows, so they are planned for the
# NBA only. Checked 2026-10-30: tracking has rows from 2013-14; hustle from 2015-16 (a few games
# that season, every game from 2016-17).
TRACKING_MEASURES = ("Passing", "Rebounding", "Possessions", "Drives", "SpeedDistance")
TRACKING_FIRST_SEASON = 2013
HUSTLE_FIRST_SEASON = 2015
_DASHBOARD_DEFAULTS = {
    "College": "",
    "Conference": "",
    "Country": "",
    "Division": "",
    "DraftPick": "",
    "DraftYear": "",
    "GameScope": "",
    "Height": "",
    "LastNGames": "0",
    "Location": "",
    "Month": "0",
    "OpponentTeamID": "0",
    "Outcome": "",
    "PORound": "0",
    "PerMode": "Totals",
    "PlayerExperience": "",
    "PlayerPosition": "",
    "SeasonSegment": "",
    "TeamID": "0",
    "VsConference": "",
    "VsDivision": "",
    "Weight": "",
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

    def __init__(
        self,
        league: League,
        season: str,
        season_type: SeasonType = "Regular Season",
        shots_scope: ShotsScope = "game",
    ):
        self.league = league
        self.season = season
        self.season_type = season_type
        self.shots_scope = shots_scope
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
            *(self.player_gamelogs_request(measure) for measure in GAMELOG_MEASURES),
            # Standings: playoff position, clinched and eliminated teams (playoff stakes).
            Request(
                "leaguestandingsv3",
                _slug(self.season_type),
                {
                    "LeagueID": self.league_id,
                    "Season": self.season,
                    "SeasonType": self.season_type,
                    "SeasonYear": "",
                },
            ),
        ]

    def player_gamelogs_request(self, measure: str) -> Request:
        """Every player-game line of the season with the given measure set, in one request.

        Replaces per-game boxscoreadvancedv3 calls: identical measures, one call per season.
        """
        return Request(
            "playergamelogs",
            f"{measure.lower()}-{_slug(self.season_type)}",
            {
                "DateFrom": "",
                "DateTo": "",
                "GameSegment": "",
                "LastNGames": "0",
                "LeagueID": self.league_id,
                "Location": "",
                "MeasureType": measure,
                "Month": "0",
                "OppTeamID": "0",
                "Outcome": "",
                "PORound": "0",
                "PerMode": "Totals",
                "Period": "0",
                "PlayerID": "",
                "Season": self.season,
                "SeasonSegment": "",
                "SeasonType": self.season_type,
                "ShotClockRange": "",
                "TeamID": "",
                "VsConference": "",
                "VsDivision": "",
            },
        )

    def day_requests(self, day: date) -> list[Request]:
        """Tracking and hustle totals for one game date, NBA only; keys like passing-2026-01-15."""
        if self.league != "nba":
            return []
        start_year = int(self.season[:4])
        stamp = day.strftime("%m/%d/%Y")
        common = {
            **_DASHBOARD_DEFAULTS,
            "DateFrom": stamp,
            "DateTo": stamp,
            "LeagueID": self.league_id,
            "Season": self.season,
            "SeasonType": self.season_type,
        }
        requests: list[Request] = []
        if start_year >= TRACKING_FIRST_SEASON:
            requests.extend(
                Request(
                    "leaguedashptstats",
                    f"{measure.lower()}-{day.isoformat()}",
                    {
                        **common,
                        "PlayerOrTeam": "Player",
                        "PtMeasureType": measure,
                        "StarterBench": "",
                    },
                )
                for measure in TRACKING_MEASURES
            )
        if start_year >= HUSTLE_FIRST_SEASON:
            requests.append(
                Request(
                    "leaguehustlestatsplayer",
                    f"hustle-{day.isoformat()}",
                    {**common, "GameSegment": "", "PaceAdjust": "N", "PlusMinus": "N", "Rank": "N"},
                )
            )
        return requests

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
        requests = [
            Request("boxscoretraditionalv3", game_id, v3),
            Request(
                "playbyplayv3",
                game_id,
                {"GameID": game_id, "StartPeriod": "0", "EndPeriod": "14"},
            ),
        ]
        if self.shots_scope == "game":
            requests.append(self._shot_request(game_id, game_id=game_id, team_id="0"))
        return requests

    def _shot_request(self, key: str, *, game_id: str, team_id: str) -> Request:
        return Request(
            "shotchartdetail",
            key,
            {
                **_SHOTCHART_DEFAULTS,
                "ContextMeasure": "FGA",
                "GameID": game_id,
                "LeagueID": self.league_id,
                "PlayerID": "0",
                "TeamID": team_id,
                "Season": self.season,
                "SeasonType": self.season_type,
            },
        )

    def shot_requests(self, team_ids: Iterable[str]) -> list[Request]:
        """Whole-season shot charts, one per team (only for the team-season scope)."""
        if self.shots_scope != "team-season":
            return []
        return [
            self._shot_request(f"{team_id}-{_slug(self.season_type)}", game_id="", team_id=team_id)
            for team_id in sorted(set(team_ids))
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


def teams_in_payload(payload: bytes | None) -> set[str]:
    """Every team id in a payload's first result set (a season game log, the player directory).

    Zero and blank ids (players without a team) are left out.
    """
    if payload is None:
        return set()
    teams = {str(row.get("TEAM_ID", "")) for row in parse_result_set(payload)}
    return {t for t in teams if t and t != "0"}


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

    def fetch(
        self, request: Request, played: date | None = None
    ) -> tuple[LandResult | None, bytes | None]:
        """Land one request. Returns (result, body); result is None when it was skipped.

        A request is skipped when it already landed today, or, for a game played on ``played``,
        when its payload is settled (landed at least two days after the game).
        """
        league = self.planner.league
        scope = Scope(SOURCE, request.endpoint, league, self.planner.season)
        if played is not None and self.landing.settled(scope, request.key, played):
            return None, None
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

    def _try(
        self, request: Request, summary: RunSummary, played: date | None = None
    ) -> bytes | None:
        try:
            result, body = self.fetch(request, played)
        except CircuitOpenError:
            raise  # the host stopped answering: stop the run rather than hammer it
        except Exception as exc:  # a failed request never fails the run
            summary.fail(request.endpoint, request.key, exc)
            return None
        summary.record(result)
        return body

    def run(self, *, since: date | None = None, until: date | None = None) -> RunSummary:
        summary = RunSummary(SOURCE, self.planner.league, self.planner.season, self._clock())
        try:
            self._run(summary, since=since, until=until)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        for failure in self.landing.flush():
            summary.fail(failure.endpoint, failure.key, failure.error)
        summary.pacing = self.client.pacing()
        return summary

    def _run(self, summary: RunSummary, *, since: date | None, until: date | None) -> None:
        gamelog = self.planner.gamelog_request()
        season = [
            (request, self._try(request, summary)) for request in self.planner.season_requests()
        ]
        gamelog_body = next((body for request, body in season if request == gamelog), None)
        directory_body = next(
            (body for request, body in season if request.endpoint == "commonallplayers"), None
        )
        games = (
            games_in_window(gamelog_body, since=since, until=until)
            if gamelog_body is not None
            else []
        )
        summary.games = len(games)
        team_ids: set[str] = set()
        for game in games:
            team_ids |= game.team_ids
            for request in self.planner.game_requests(game.game_id):
                self._try(request, summary, played=game.game_date)
        # Tracking and hustle by game date, settled like the games of that date.
        for day in sorted({game.game_date for game in games}):
            for request in self.planner.day_requests(day):
                self._try(request, summary, played=day)
        for request in self.planner.shot_requests(team_ids):
            self._try(request, summary)
        # Every team's roster, every run, not only teams that played in the window: out of
        # season (free agency, the draft, trades before opening night) there are no games,
        # yet the board drafts from these rosters. Teams come from the whole season's game log
        # and from the current player directory, which also names a team before its first game.
        all_teams = team_ids | teams_in_payload(gamelog_body) | teams_in_payload(directory_body)
        for request in self.planner.roster_requests(all_teams):
            self._try(request, summary)
