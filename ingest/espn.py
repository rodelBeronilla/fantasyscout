"""ESPN public JSON ingestor: scoreboard, game summary, teams, rosters, injuries.

ESPN is the second source. It reconciles the stats API's box scores, supplies injury
status, and stands in as the live source wherever the stats API cannot be reached.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from ingest.http import CircuitOpenError, ThrottledClient
from ingest.landing import League
from ingest.run import MissingPayloadError, RunSummary
from ingest.store import Landing, LandResult, Scope

SOURCE = "espn"
BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball"


@dataclass(frozen=True)
class Request:
    endpoint: str
    key: str
    path: str
    params: dict[str, str] = field(default_factory=dict)

    def url(self, league: League) -> str:
        return f"{BASE}/{league}/{self.path}"


@dataclass(frozen=True)
class Event:
    event_id: str
    event_date: date
    completed: bool
    team_ids: frozenset[str]


class EspnPlanner:
    def __init__(self, league: League, season: str) -> None:
        self.league = league
        self.season = season

    @staticmethod
    def scoreboard_request(day: date) -> Request:
        stamp = day.strftime("%Y%m%d")
        return Request("scoreboard", stamp, "scoreboard", {"dates": stamp, "limit": "100"})

    @staticmethod
    def summary_request(event_id: str) -> Request:
        return Request("summary", event_id, "summary", {"event": event_id})

    @staticmethod
    def teams_request() -> Request:
        return Request("teams", "league", "teams", {"limit": "50"})

    @staticmethod
    def roster_request(team_id: str) -> Request:
        return Request("roster", team_id, f"teams/{team_id}/roster")

    @staticmethod
    def injuries_request() -> Request:
        return Request("injuries", "league", "injuries")


def days_between(since: date, until: date) -> list[date]:
    if until < since:
        return []
    return [since + timedelta(days=i) for i in range((until - since).days + 1)]


def events_from_scoreboard(payload: bytes) -> list[Event]:
    doc = json.loads(payload)
    events: list[Event] = []
    for ev in doc.get("events") or []:
        event_id = str(ev.get("id", ""))
        raw_date = str(ev.get("date", ""))
        if not event_id or not raw_date:
            continue
        status = (ev.get("status") or {}).get("type") or {}
        teams: set[str] = set()
        for comp in ev.get("competitions") or []:
            for c in comp.get("competitors") or []:
                team_id = str((c.get("team") or {}).get("id", ""))
                if team_id:
                    teams.add(team_id)
        events.append(
            Event(
                event_id,
                date.fromisoformat(raw_date[:10]),
                bool(status.get("completed")),
                frozenset(teams),
            )
        )
    return events


def team_ids_from_teams(payload: bytes) -> list[str]:
    doc = json.loads(payload)
    ids: list[str] = []
    for sport in doc.get("sports") or []:
        for league in sport.get("leagues") or []:
            for entry in league.get("teams") or []:
                team_id = str((entry.get("team") or {}).get("id", ""))
                if team_id:
                    ids.append(team_id)
    return sorted(set(ids))


class EspnIngestor:
    def __init__(
        self,
        client: ThrottledClient,
        landing: Landing,
        planner: EspnPlanner,
        *,
        now: datetime | None = None,
    ) -> None:
        self.client = client
        self.landing = landing
        self.planner = planner
        self._now = now

    def _clock(self) -> datetime:
        return self._now or datetime.now(UTC)

    def _scope(self, endpoint: str) -> Scope:
        return Scope(SOURCE, endpoint, self.planner.league, self.planner.season)

    def fetch(
        self, request: Request, played: date | None = None
    ) -> tuple[LandResult | None, bytes | None]:
        """Land one request; skipped (result None) when landed today or, for a day or game
        played on ``played``, when its payload is settled. A settled scoreboard returns its
        landed body, which the run still plans games from."""
        scope = self._scope(request.endpoint)
        if played is not None and self.landing.settled(scope, request.key, played):
            body = (
                self.landing.read_latest(scope, request.key)
                if request.endpoint == "scoreboard"
                else None
            )
            return None, body
        if self.landing.already_landed_today(scope, request.key):
            return None, self.landing.read_latest(scope, request.key)
        url = request.url(self.planner.league)
        response = self.client.get(url, params=request.params)
        if response.status_code == 404 and request.endpoint == "summary":
            # ESPN lists a few events (cancelled, placeholders) it never writes a summary for.
            msg = "HTTP 404: no summary at source"
            raise MissingPayloadError(msg)
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
        except MissingPayloadError as exc:
            summary.miss(request.endpoint, request.key, str(exc))
            return None
        except Exception as exc:  # a failed request never fails the run
            summary.fail(request.endpoint, request.key, exc)
            return None
        summary.record(result)
        return body

    def run(self, *, since: date, until: date, rosters: bool = True, ahead: int = 0) -> RunSummary:
        """Land the window's scoreboards and summaries, then (with ``ahead``) the scoreboards of
        that many days after ``until``: upcoming games carry the betting lines (game_lines)."""
        summary = RunSummary(SOURCE, self.planner.league, self.planner.season, self._clock())
        try:
            self._run(summary, since=since, until=until, rosters=rosters)
            for day in days_between(until + timedelta(days=1), until + timedelta(days=ahead)):
                self._try(self.planner.scoreboard_request(day), summary)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        for failure in self.landing.flush():
            summary.fail(failure.endpoint, failure.key, failure.error)
        summary.pacing = self.client.pacing()
        return summary

    def _run(self, summary: RunSummary, *, since: date, until: date, rosters: bool) -> None:
        events: list[Event] = []
        for day in days_between(since, until):
            body = self._try(self.planner.scoreboard_request(day), summary, played=day)
            if body is not None:
                events.extend(events_from_scoreboard(body))
        seen: set[str] = set()
        completed: list[Event] = []
        for event in events:
            if event.completed and event.event_id not in seen:
                seen.add(event.event_id)
                completed.append(event)
        summary.games = len(completed)
        for event in completed:
            self._try(
                self.planner.summary_request(event.event_id), summary, played=event.event_date
            )
        if rosters:
            teams_body = self._try(self.planner.teams_request(), summary)
            team_ids: Iterable[str] = team_ids_from_teams(teams_body) if teams_body else ()
            for team_id in team_ids:
                self._try(self.planner.roster_request(team_id), summary)
        self._try(self.planner.injuries_request(), summary)
