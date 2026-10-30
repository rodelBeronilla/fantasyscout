"""The leagues' referee assignments: who officiates each of today's games.

official.nba.com posts the day's crews at about 9 am Eastern on one page, an NBA table and a
WNBA table, each under a heading with the date it is for. A row names the game ("Chicago @
Boston") and, for the crew chief, the referee, the umpire and (sometimes) the alternate, the
official's name and uniform number ("Pat Fraher (#26)"). A league with no games that day shows
an empty table, or none at all.

The page is parsed here, at ingest, into JSON rows, one per game, and only the rows are landed,
keyed by the date the page is for. Each league's run lands its own table, at most once a day: a
run that finds today's crews already landed asks for nothing.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from zoneinfo import ZoneInfo

from ingest.http import CircuitOpenError, ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

SOURCE = "league"
ENDPOINT = "referee_assignments"
EASTERN = ZoneInfo("America/New_York")
URL = "https://official.nba.com/referee-assignments/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "text/html,*/*",
}
# Column headings on the page, to the keys a landed row uses.
ROLES = {
    "crew chief": "crew_chief",
    "referee": "referee",
    "umpire": "umpire",
    "alternate": "alternate",
}
SECTION = re.compile(r"^(NBA|WNBA|G League)\s+Referee Assignments$", re.IGNORECASE)
OFFICIAL = re.compile(r"^(?P<name>.*?)\s*(?:\(#\s*(?P<number>\d+)\s*\))?$")


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_official(text: str) -> tuple[str | None, int | None]:
    """'Pat Fraher (#26)' -> ('Pat Fraher', 26); an empty cell -> (None, None)."""
    m = OFFICIAL.match(_clean(text))
    if m is None or not m.group("name"):
        return None, None
    number = m.group("number")
    return m.group("name"), int(number) if number else None


def parse_page_date(text: str) -> str | None:
    """'October 30, 2026' -> '2026-10-30'."""
    try:
        return datetime.strptime(_clean(text), "%B %d, %Y").date().isoformat()
    except ValueError:
        return None


@dataclass
class _Section:
    league: str
    date: str | None = None
    headings: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)


class _PageParser(HTMLParser):
    """Collects each league section's date, table headings and table rows."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[_Section] = []
        self._capture: str | None = None  # "title", "date", "th" or "td"
        self._buffer: list[str] = []
        self._row: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        classes = (dict(attrs).get("class") or "").split()
        if tag == "h1" and "entry-title" in classes:
            self._start("title")
        elif tag == "div" and "entry-meta" in classes:
            self._start("date")
        elif tag == "tr":
            self._row = []
        elif tag in ("th", "td") and self._row is not None:
            self._start(tag)

    def handle_endtag(self, tag: str) -> None:
        if self._capture == "title" and tag == "h1":
            m = SECTION.match(self._take())
            self.sections.append(_Section(m.group(1).lower() if m else "other"))
        elif self._capture == "date" and tag == "div":
            text = self._take()
            if self.sections and self.sections[-1].date is None:
                self.sections[-1].date = parse_page_date(text)
        elif self._capture == "th" and tag == "th":
            text = self._take()
            if self.sections:
                self.sections[-1].headings.append(text.lower())
        elif self._capture == "td" and tag == "td":
            text = self._take()
            if self._row is not None:
                self._row.append(text)
        elif tag == "tr" and self._row is not None:
            row, self._row = self._row, None
            if self.sections and row:  # a heading row collects no td cells
                self.sections[-1].rows.append(row)

    def handle_data(self, data: str) -> None:
        if self._capture is not None:
            self._buffer.append(data)

    def _start(self, kind: str) -> None:
        self._capture = kind
        self._buffer = []

    def _take(self) -> str:
        text = _clean("".join(self._buffer))
        self._capture = None
        self._buffer = []
        return text


def _game_row(headings: list[str], cells: list[str]) -> dict[str, Any] | None:
    by_heading = dict(zip(headings, cells, strict=False))
    game = by_heading.get("game", "")
    if "@" not in game:
        return None
    away, home = (_clean(part) for part in game.split("@", 1))
    row: dict[str, Any] = {"game": game, "away_team": away, "home_team": home}
    for heading, key in ROLES.items():
        name, number = parse_official(by_heading.get(heading, ""))
        row[key] = name
        row[f"{key}_number"] = number
    return row


def parse_assignments(html: str) -> dict[str, dict[str, Any]]:
    """Each league's section of the page: the date it is for and one row per game.

    A league whose table is empty, or which has no table, maps to no rows.
    """
    parser = _PageParser()
    parser.feed(html)
    parser.close()
    out: dict[str, dict[str, Any]] = {}
    for section in parser.sections:
        if section.league not in ("nba", "wnba") or section.league in out:
            continue
        rows = [r for cells in section.rows if (r := _game_row(section.headings, cells))]
        out[section.league] = {"date": section.date, "rows": rows}
    return out


@dataclass
class RefereeAssignmentsIngestor:
    """Lands the league's referee assignments for today, once per Eastern day."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def land_into(self, summary: RunSummary) -> None:
        clock = self.now or datetime.now(UTC)
        today = clock.astimezone(EASTERN).date().isoformat()
        scope = Scope(SOURCE, ENDPOINT, self.league, self.season)
        try:
            if self.landing.has_landed(scope, today):
                summary.record(None)
                return
            response = self.client.get(URL, headers=HEADERS)
            if response.status_code != 200:
                summary.fail(ENDPOINT, today, RuntimeError(f"HTTP {response.status_code}"))
                return
            section = parse_assignments(response.text).get(self.league)
            # No table, an empty one (no games), or yesterday's still up: nothing to record.
            if not section or not section["rows"] or section["date"] is None:
                return
            if self.landing.has_landed(scope, section["date"]):
                summary.record(None)
                return
            payload = {
                "league": self.league,
                "page_date": section["date"],
                "url": URL,
                "rows": section["rows"],
            }
            body = json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8")
            result = self.landing.land(
                scope, section["date"], body, url=URL, params={}, status=200, fetched_at=clock
            )
            summary.record(result)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # the assignments never fail the run
            summary.fail(ENDPOINT, today, exc)
