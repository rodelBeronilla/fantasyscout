"""Player prop lines: the line a sportsbook sets on a player's points, rebounds, assists and more.

A private model input and a check on the board's projections (ADR 0008, addendum on prop lines).
Props never reach a public page or the public JSON, and nothing here picks a side.

Two sources, both landed by the reports run for both leagues:

- ESPN's core API, DraftKings (provider 100). The ingestor reads ESPN's scoreboard for today and
  tomorrow (Eastern) and fetches the prop bets of every event that has not tipped off. The feed
  pages at 1,000 items; an NBA game has about 1,200, most of them milestones and quarter lines.
  Only the player totals are kept (points, rebounds, assists, threes, steals, blocks and their
  combinations): one entry per player and market with the line, the over and under prices, the
  opening line and prices, and when DraftKings last moved it. ESPN lists each total twice, the
  over first and then the under, and does not label the sides. The order was checked against
  the milestone prices: a 22+ points milestone is priced like the over at 21.5, and 94 of 97
  totals in one NBA game agreed, the other three being near-ties.
- The Odds API (v4), every US bookmaker, for the games of the next 36 hours. The ingestor makes
  one odds call per event per run, which costs a credit per market returned (up to seven). It
  runs only when ODDS_API_KEY is set; without it the source is recorded as skipped. The credits
  left are logged from the response headers, and the run stops calling once fewer remain than
  one call costs. The key is never written to a sidecar or a log.

Each payload lands under the event and the Eastern date and hour of the run, so the morning's and
the evening's lines are both kept.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from ingest.http import CircuitOpenError, ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

EASTERN = ZoneInfo("America/New_York")

SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/{league}/scoreboard"
PROP_BETS_URL = (
    "https://sports.core.api.espn.com/v2/sports/basketball/leagues/{league}/events/{event}"
    "/competitions/{event}/odds/{provider}/propBets"
)
DRAFTKINGS = "100"
PAGE_SIZE = 1000
MAX_PAGES = 10

ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/{sport}"
ODDS_API_SPORT: dict[League, str] = {"nba": "basketball_nba", "wnba": "basketball_wnba"}
ODDS_API_MARKETS = (
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_threes",
    "player_blocks",
    "player_steals",
    "player_turnovers",
)
LOOKAHEAD = timedelta(hours=36)

_ATHLETE = re.compile(r"/athletes/(\d+)")


def snapshot_key(now: datetime) -> str:
    """The Eastern date and hour of a run, YYYY-MM-DDTHH: one snapshot per run."""
    return f"{now.astimezone(EASTERN):%Y-%m-%dT%H}"


def iso_utc(value: object) -> str | None:
    """A source timestamp ("2026-10-30T23:00Z", "2026-10-30T23:00:00Z") as ISO 8601 UTC."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat(timespec="seconds")


def eastern_date(value: str) -> str:
    return datetime.fromisoformat(value).astimezone(EASTERN).date().isoformat()


def _number(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def american(value: object) -> int | None:
    """An American price ("-106", "+101", 150, "EVEN") as an integer."""
    if isinstance(value, str) and value.strip().upper() == "EVEN":
        return 100
    number = _number(value.replace("+", "") if isinstance(value, str) else value)
    return None if number is None else round(number)


@dataclass(frozen=True)
class UpcomingEvent:
    event_id: str
    commence_at: str
    home_team_id: str | None
    away_team_id: str | None


def upcoming_events(body: bytes) -> list[UpcomingEvent]:
    """The events on an ESPN scoreboard that have not started (status state "pre")."""
    out: list[UpcomingEvent] = []
    for ev in json.loads(body).get("events") or []:
        state = ((ev.get("status") or {}).get("type") or {}).get("state")
        event_id = str(ev.get("id") or "")
        commence = iso_utc(ev.get("date"))
        if state != "pre" or not event_id or commence is None:
            continue
        sides: dict[str, str | None] = {}
        for comp in (ev.get("competitions") or [])[:1]:
            for c in comp.get("competitors") or []:
                sides[str(c.get("homeAway"))] = str((c.get("team") or {}).get("id") or "") or None
        out.append(UpcomingEvent(event_id, commence, sides.get("home"), sides.get("away")))
    return out


def _athlete_id(item: Mapping[str, Any]) -> str | None:
    match = _ATHLETE.search(str((item.get("athlete") or {}).get("$ref") or ""))
    return match.group(1) if match else None


def trim_prop_bets(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The player totals among ESPN's prop bets, one entry per player and market.

    ESPN lists each total twice, the over and then the under. A total quoted once, or more than
    twice, or with two different lines, cannot be split into sides and is dropped.
    """
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in items:
        athlete = _athlete_id(item)
        prop_type = item.get("type") or {}
        total = (item.get("odds") or {}).get("total") or {}
        if (
            athlete is None
            or not str(prop_type.get("name") or "").startswith("Total ")
            or _number(total.get("value")) is None
        ):
            continue
        groups.setdefault((athlete, str(prop_type.get("id"))), []).append(item)
    out: list[dict[str, Any]] = []
    for (athlete, type_id), quotes in groups.items():
        if len(quotes) != 2:
            continue
        over, under = quotes
        line = _number(over["odds"]["total"].get("value"))
        if line != _number(under["odds"]["total"].get("value")):
            continue
        updated = [
            u for u in (iso_utc(over.get("lastUpdated")), iso_utc(under.get("lastUpdated"))) if u
        ]
        out.append(
            {
                "athlete_id": athlete,
                "type_id": type_id,
                "prop_type": over["type"].get("name"),
                "line": line,
                "open_line": _number(over["odds"]["total"].get("open")),
                "over_odds": american((over["odds"].get("american") or {}).get("value")),
                "under_odds": american((under["odds"].get("american") or {}).get("value")),
                "over_open_odds": american((over["odds"].get("american") or {}).get("open")),
                "under_open_odds": american((under["odds"].get("american") or {}).get("open")),
                "last_updated": max(updated) if updated else None,
            }
        )
    return out


def pair_outcomes(doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The Odds API's outcomes as one entry per bookmaker, market, player and line."""
    out: list[dict[str, Any]] = []
    for book in doc.get("bookmakers") or []:
        for market in book.get("markets") or []:
            sides: dict[tuple[str, float], dict[str, int | None]] = {}
            for outcome in market.get("outcomes") or []:
                player = outcome.get("description")
                point = _number(outcome.get("point"))
                side = str(outcome.get("name") or "").lower()
                if not player or point is None or side not in ("over", "under"):
                    continue
                sides.setdefault((str(player), point), {})[side] = american(outcome.get("price"))
            for (player, point), prices in sides.items():
                out.append(
                    {
                        "bookmaker": book.get("key"),
                        "market": market.get("key"),
                        "player_name": player,
                        "line": point,
                        "over_odds": prices.get("over"),
                        "under_odds": prices.get("under"),
                        "last_updated": iso_utc(
                            market.get("last_update") or book.get("last_update")
                        ),
                    }
                )
    return out


def _encode(doc: Mapping[str, Any]) -> bytes:
    return json.dumps(doc, ensure_ascii=False).encode("utf-8")


@dataclass
class EspnPropsIngestor:
    """Lands DraftKings' player totals from ESPN for today's and tomorrow's games."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def land_into(self, summary: RunSummary) -> None:
        now = self.now or datetime.now(UTC)
        snapshot = snapshot_key(now)
        today = now.astimezone(EASTERN).date()
        events: dict[str, UpcomingEvent] = {}
        try:
            for day in (today, today + timedelta(days=1)):
                stamp = day.strftime("%Y%m%d")
                response = self.client.get(
                    SCOREBOARD_URL.format(league=self.league),
                    params={"dates": stamp, "limit": "100"},
                )
                if response.status_code != 200:
                    summary.fail(
                        "prop_bets",
                        f"scoreboard-{stamp}",
                        RuntimeError(f"HTTP {response.status_code}"),
                    )
                    continue
                for event in upcoming_events(response.content):
                    events.setdefault(event.event_id, event)
            for event in events.values():
                self._land_event(summary, event, snapshot, now)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # props never fail the run
            summary.fail("prop_bets", snapshot, exc)

    def _land_event(
        self, summary: RunSummary, event: UpcomingEvent, snapshot: str, now: datetime
    ) -> None:
        scope = Scope("espn", "prop_bets", self.league, self.season)
        key = f"{event.event_id}-{snapshot}"
        url = PROP_BETS_URL.format(league=self.league, event=event.event_id, provider=DRAFTKINGS)
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return
            items: list[dict[str, Any]] = []
            page = 1
            while True:
                response = self.client.get(url, params={"limit": str(PAGE_SIZE), "page": str(page)})
                if response.status_code == 404:  # no props posted for the event (yet)
                    summary.miss("prop_bets", key, "HTTP 404: no props at source")
                    return
                if response.status_code != 200:
                    summary.fail("prop_bets", key, RuntimeError(f"HTTP {response.status_code}"))
                    return
                doc = response.json()
                items.extend(doc.get("items") or [])
                if page >= int(doc.get("pageCount") or 1) or page >= MAX_PAGES:
                    break
                page += 1
            body = _encode(
                {
                    "event_id": event.event_id,
                    "provider_id": DRAFTKINGS,
                    "provider": "draftkings",
                    "snapshot_key": snapshot,
                    "fetched_at": now.astimezone(UTC).isoformat(timespec="seconds"),
                    "commence_at": event.commence_at,
                    "game_date_et": eastern_date(event.commence_at),
                    "home_team_id": event.home_team_id,
                    "away_team_id": event.away_team_id,
                    "items_at_source": len(items),
                    "props": trim_prop_bets(items),
                }
            )
            result = self.landing.land(
                scope,
                key,
                body,
                url=url,
                params={"limit": str(PAGE_SIZE)},
                status=200,
                fetched_at=now,
            )
            summary.record(result)
        except CircuitOpenError:
            raise
        except Exception as exc:  # one event never stops the others
            summary.fail("prop_bets", key, exc)


@dataclass
class OddsApiIngestor:
    """Lands every US bookmaker's player props from The Odds API, when a key is configured."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    api_key: str = ""
    now: datetime | None = None
    remaining: float | None = field(default=None, init=False)

    def land_into(self, summary: RunSummary) -> None:
        if not self.api_key:
            print(f"odds api {self.league}: ODDS_API_KEY is not set; skipped")
            summary.record(None)
            return
        now = self.now or datetime.now(UTC)
        snapshot = snapshot_key(now)
        base = ODDS_API_URL.format(sport=ODDS_API_SPORT[self.league])
        try:
            # Listing events costs no credits.
            response = self.client.get(
                f"{base}/events",
                params={
                    "apiKey": self.api_key,
                    "dateFormat": "iso",
                    "commenceTimeFrom": _odds_time(now),
                    "commenceTimeTo": _odds_time(now + LOOKAHEAD),
                },
            )
            if response.status_code != 200:
                summary.fail("player_props", "events", RuntimeError(f"HTTP {response.status_code}"))
                return
            events = [e for e in response.json() if _upcoming(e, now)]
            for event in events:
                if self.remaining is not None and self.remaining < len(ODDS_API_MARKETS):
                    summary.record(None)  # out of credits: the rest of the window waits
                    continue
                self._land_event(summary, base, event, snapshot, now)
            if self.remaining is not None and self.remaining < len(ODDS_API_MARKETS):
                print(
                    f"odds api {self.league}: {self.remaining:.0f} credits left, fewer than one "
                    "call costs; stopped"
                )
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # props never fail the run
            summary.fail("player_props", snapshot, exc)

    def _credits(self, event_id: str, response: httpx.Response) -> None:
        remaining = _number(response.headers.get("x-requests-remaining"))
        used = response.headers.get("x-requests-used", "?")
        last = response.headers.get("x-requests-last", "?")
        if remaining is not None:
            self.remaining = remaining
        print(
            f"odds api {self.league} {event_id}: cost {last}, used {used}, "
            f"remaining {response.headers.get('x-requests-remaining', '?')}"
        )

    def _land_event(
        self,
        summary: RunSummary,
        base: str,
        event: Mapping[str, Any],
        snapshot: str,
        now: datetime,
    ) -> None:
        scope = Scope("odds_api", "player_props", self.league, self.season)
        event_id = str(event.get("id") or "")
        key = f"{event_id}-{snapshot}"
        url = f"{base}/events/{event_id}/odds"
        params = {
            "regions": "us",
            "markets": ",".join(ODDS_API_MARKETS),
            "oddsFormat": "american",
            "dateFormat": "iso",
        }
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return
            response = self.client.get(url, params={**params, "apiKey": self.api_key})
            self._credits(event_id, response)
            if response.status_code == 404:
                summary.miss("player_props", key, "HTTP 404: event gone at source")
                return
            if response.status_code != 200:
                summary.fail("player_props", key, RuntimeError(f"HTTP {response.status_code}"))
                return
            doc = response.json()
            commence = iso_utc(doc.get("commence_time") or event.get("commence_time"))
            body = _encode(
                {
                    "event_id": event_id,
                    "sport_key": doc.get("sport_key") or event.get("sport_key"),
                    "snapshot_key": snapshot,
                    "fetched_at": now.astimezone(UTC).isoformat(timespec="seconds"),
                    "commence_at": commence,
                    "game_date_et": eastern_date(commence) if commence else None,
                    "home_team": doc.get("home_team") or event.get("home_team"),
                    "away_team": doc.get("away_team") or event.get("away_team"),
                    "props": pair_outcomes(doc),
                }
            )
            result = self.landing.land(
                scope, key, body, url=url, params=params, status=200, fetched_at=now
            )
            summary.record(result)
        except CircuitOpenError:
            raise
        except Exception as exc:  # one event never stops the others
            summary.fail("player_props", key, exc)


def _odds_time(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _upcoming(event: Mapping[str, Any], now: datetime) -> bool:
    commence = iso_utc(event.get("commence_time"))
    if commence is None or not event.get("id"):
        return False
    return now < datetime.fromisoformat(commence) <= now + LOOKAHEAD
