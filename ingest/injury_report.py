"""The leagues' official injury reports: the PDF each league publishes through the day.

The NBA posts a report every 15 minutes on game days and lists them on official.nba.com; the
WNBA posts to the same host with no index page, so its latest report is found by trying the
most recent quarter hours. A report lists, per game and team, every player with a status (Out,
Doubtful, Questionable, Probable, Available) and a reason, G League assignments and two-way
players included, and "NOT YET SUBMITTED" for a team that has not filed yet.

The PDF is parsed here, at ingest, into JSON rows, the shape the rest of the platform lands and
reads; the PDF's hash and address are kept with them. Parsing works from word positions: the
columns are fixed, and a reason that wraps sits half above and half below its player's line, so
every fragment goes to the nearest player line, while the date, matchup and team carry down the
page to the players under them.
"""

from __future__ import annotations

import io
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pdfplumber

from ingest.http import CircuitOpenError, ThrottledClient
from ingest.landing import League, payload_hash
from ingest.run import RunSummary
from ingest.store import Landing, Scope

SOURCE = "league"
ENDPOINT = "injury_report"
EASTERN = ZoneInfo("America/New_York")
PDF_BASE = {
    "nba": "https://ak-static.cms.nba.com/referee/injury/",
    "wnba": "https://ak-static.cms.nba.com/referee/wnba_injury/",
}
NBA_INDEX = "https://official.nba.com/nba-injury-report-{season}-season/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "text/html,application/pdf,*/*",
}
# Reports are named for the Eastern time they were published: 05_00PM since the 2025-26 season
# (every 15 minutes), 05PM before it (hourly). Both stay on the host: the NBA's back to 2023-24.
REPORT_NAME = re.compile(r"Injury-Report_(\d{4}-\d{2}-\d{2})_(\d{2})(?:_(\d{2}))?(AM|PM)\.pdf")
# The report a history run lands for each day: 5 pm Eastern, after teams file for the day's games
# and before most tip-offs, close to when the evening build reads the newest one.
HISTORY_HOUR = 17
NEW_NAMES_FROM = date(2025, 12, 15)
# How far back to look for a WNBA report, in quarter hours (a day), and in which months.
WNBA_PROBES = 96
WNBA_MONTHS = range(5, 11)

# Column starts (x, in points) when a page has no header row: the layout both leagues use.
DEFAULT_COLUMNS = {
    "game_date": 23.0,
    "game_time": 119.0,
    "matchup": 200.0,
    "team": 264.0,
    "player": 425.0,
    "status": 585.0,
    "reason": 666.0,
}
HEADER_WORDS = {
    "Game Date": "game_date",
    "Game Time": "game_time",
    "Matchup": "matchup",
    "Team": "team",
    "Player Name": "player",
    "Current Status": "status",
    "Reason": "reason",
}
STATUSES = {"Out", "Doubtful", "Questionable", "Probable", "Available"}
NOT_SUBMITTED = "NOT YET SUBMITTED"


def report_name(at: datetime) -> str:
    """The file name of the report published at ``at`` (Eastern time)."""
    return f"Injury-Report_{at:%Y-%m-%d}_{at:%I}_{at:%M}{at:%p}.pdf"


def report_time(name: str) -> datetime | None:
    m = REPORT_NAME.search(name)
    if not m:
        return None
    day, hour, minute, half = m.groups()
    return datetime.strptime(f"{day} {hour}:{minute or '00'} {half}", "%Y-%m-%d %I:%M %p").replace(
        tzinfo=EASTERN
    )


def history_names(day: date, hour: int = HISTORY_HOUR) -> list[str]:
    """The names a day's report at ``hour`` (Eastern) may have: the current form, then the old."""
    at = datetime(day.year, day.month, day.day, hour, tzinfo=EASTERN)
    names = [report_name(at), f"Injury-Report_{at:%Y-%m-%d}_{at:%I}{at:%p}.pdf"]
    # The quarter-hour names began during the 2025-26 season: try the likelier form first.
    return names if day >= NEW_NAMES_FROM else names[::-1]


def latest_in_index(html: str) -> str | None:
    """The newest report linked from the NBA's index page."""
    names = {m.group(0) for m in REPORT_NAME.finditer(html)}
    timed = [(t, n) for n in names if (t := report_time(n)) is not None]
    return max(timed)[1] if timed else None


@dataclass
class _Line:
    top: float
    bottom: float
    cells: dict[str, list[str]] = field(default_factory=dict)

    @property
    def middle(self) -> float:
        return (self.top + self.bottom) / 2


def _text(words: list[str]) -> str:
    text = " ".join(words)
    # The PDF spaces punctuation as separate words: "Injury/Illness - Right Foot", "a / b".
    return re.sub(r"\s*/\s*", "/", text).strip()


def _column_of(x0: float, starts: list[tuple[str, float]]) -> str:
    """The column a word starting at ``x0`` falls in: the last column starting at or before it."""
    name = starts[0][0]
    for col, start in starts:
        if x0 >= start - 3:
            name = col
    return name


def _first_last(name: str) -> str:
    """'Jackson Jr., Jaren' -> 'Jaren Jackson Jr.'."""
    if "," not in name:
        return name.strip()
    last, first = name.split(",", 1)
    return f"{first.strip()} {last.strip()}".strip()


def parse_report(pdf: bytes) -> list[dict[str, Any]]:
    """Rows of one injury report: one per player listed, plus one per team not yet submitted."""
    rows: list[dict[str, Any]] = []
    columns = dict(DEFAULT_COLUMNS)
    carried: dict[str, str | None] = {
        "game_date": None,
        "game_time": None,
        "matchup": None,
        "team": None,
    }
    with pdfplumber.open(io.BytesIO(pdf)) as doc:
        for page in doc.pages:
            words = page.extract_words(x_tolerance=1.5)
            header_bottom = _read_header(words, columns)
            body = [w for w in words if w["top"] > header_bottom and w["top"] < page.height - 60]
            starts = sorted(columns.items(), key=lambda kv: kv[1])

            lines: dict[float, _Line] = {}
            for w in body:
                key = round(w["top"], 0)
                line = lines.setdefault(key, _Line(w["top"], w["bottom"]))
                line.cells.setdefault(_column_of(w["x0"], starts), []).append(w["text"])
            ordered = sorted(lines.values(), key=lambda ln: ln.top)
            # A row is anchored by a player, or by a team that has not submitted its report.
            anchors = [
                ln
                for ln in ordered
                if ln.cells.get("player") or _text(ln.cells.get("reason", [])) == NOT_SUBMITTED
            ]
            if not anchors:
                continue
            gathered: dict[int, dict[str, list[str]]] = {id(a): {} for a in anchors}
            for ln in ordered:
                nearest = min(anchors, key=lambda a: abs(a.middle - ln.middle))
                for col, parts in ln.cells.items():
                    if col == "player" and ln is not nearest:
                        continue
                    gathered[id(nearest)].setdefault(col, []).append(_text(parts))
            for anchor in anchors:
                cells = gathered[id(anchor)]
                # A new matchup starts a new game: its team is named on the same row.
                if cells.get("matchup"):
                    carried["team"] = None
                for col in ("game_date", "game_time", "matchup", "team"):
                    if cells.get(col):
                        carried[col] = " ".join(cells[col])
                reason = " ".join(cells.get("reason", [])).strip()
                player = " ".join(cells.get("player", [])).strip()
                status = " ".join(cells.get("status", [])).strip()
                rows.append(
                    {
                        "game_date": carried["game_date"],
                        "game_time_et": (carried["game_time"] or "").replace("(ET)", "").strip()
                        or None,
                        "matchup": carried["matchup"],
                        "team": carried["team"],
                        "player_name": _first_last(player) if player else None,
                        "player_name_listed": player or None,
                        "status": status if status in STATUSES else (status or None),
                        "reason": None if reason in ("", "-") else reason,
                        "not_submitted": reason == NOT_SUBMITTED and not player,
                    }
                )
    return rows


def _read_header(words: list[dict[str, Any]], columns: dict[str, float]) -> float:
    """Update the column starts from a header row if the page has one; return where it ends."""
    tops: dict[float, list[dict[str, Any]]] = {}
    for w in words:
        tops.setdefault(round(w["top"], 0), []).append(w)
    for _top, ws in sorted(tops.items()):
        text = " ".join(w["text"] for w in sorted(ws, key=lambda w: w["x0"]))
        if "Player Name" in text and "Reason" in text:
            ordered = sorted(ws, key=lambda w: w["x0"])
            for label, col in HEADER_WORDS.items():
                first = label.split()[0]
                for i, w in enumerate(ordered):
                    if w["text"] != first:
                        continue
                    following = " ".join(x["text"] for x in ordered[i : i + len(label.split())])
                    if following == label:
                        columns[col] = w["x0"]
                        break
            return float(max(w["bottom"] for w in ws))
    # No header: skip the title line ("Injury Report: 10/29/26 06:45 PM").
    title = [w for w in words if w["text"] == "Report:"]
    return max((w["bottom"] for w in title), default=0.0)


@dataclass
class InjuryReportIngestor:
    """Lands the league's newest injury report, parsed, unless it already landed."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None
    _probed: bytes | None = field(default=None, init=False, repr=False)

    def _clock(self) -> datetime:
        return self.now or datetime.now(UTC)

    def _latest_name(self, summary: RunSummary) -> str | None:
        if self.league == "nba":
            url = NBA_INDEX.format(season=self.season)  # the page is named for the season, 2026-27
            response = self.client.get(url, headers=HEADERS)
            if response.status_code != 200:
                summary.fail("injury_report", "index", RuntimeError(f"HTTP {response.status_code}"))
                return None
            return latest_in_index(response.text)
        # The WNBA has no index: try the most recent quarter hours, in season only.
        local = self._clock().astimezone(EASTERN)
        if local.month not in WNBA_MONTHS:
            return None
        at = local.replace(minute=local.minute - local.minute % 15, second=0, microsecond=0)
        for _ in range(WNBA_PROBES):
            name = report_name(at)
            response = self.client.get(PDF_BASE["wnba"] + name, headers=HEADERS)
            if response.status_code == 200:
                self._probed = response.content
                return name
            at -= timedelta(minutes=15)
        return None

    def run(self) -> RunSummary:
        summary = RunSummary(SOURCE, self.league, self.season, self._clock())
        self._probed = None
        try:
            name = self._latest_name(summary)
            if name is None:
                return summary
            published = report_time(name)
            key = published.strftime("%Y-%m-%dT%H-%M") if published else name
            scope = Scope(SOURCE, ENDPOINT, self.league, self.season)
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return summary
            url = PDF_BASE[self.league] + name
            pdf = self._probed
            if pdf is None:
                response = self.client.get(url, headers=HEADERS)
                if response.status_code != 200:
                    summary.fail(ENDPOINT, key, RuntimeError(f"HTTP {response.status_code}"))
                    return summary
                pdf = response.content
            rows = parse_report(pdf)
            payload = {
                "league": self.league,
                "report": name,
                "published_et": published.isoformat() if published else None,
                "url": url,
                "pdf_sha256": payload_hash(pdf),
                "rows": rows,
            }
            body = json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8")
            result = self.landing.land(
                scope, key, body, url=url, params={}, status=200, fetched_at=self._clock()
            )
            summary.games = len({r["matchup"] for r in rows if r["matchup"]})
            summary.record(result)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # a broken report never fails the ingest
            summary.fail(ENDPOINT, "latest", exc)
        for failure in self.landing.flush():
            summary.fail(failure.endpoint, failure.key, failure.error)
        summary.pacing = self.client.pacing()
        return summary


@dataclass
class ReportHistoryIngestor:
    """Lands one official report per day over a date range: the 5 pm Eastern report.

    Each league keeps its reports on the host (the NBA's back to 2023-24, the WNBA's from 2026),
    so the history the availability calibration needs can be landed after the fact. A day with no
    report (no games, or before the archive) answers 403 or 404 and is skipped, not failed.
    """

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    since: date
    until: date
    now: datetime | None = None

    def run(self) -> RunSummary:
        clock = self.now or datetime.now(UTC)
        summary = RunSummary(SOURCE, self.league, self.season, clock)
        scope = Scope(SOURCE, ENDPOINT, self.league, self.season)
        day = self.since
        try:
            while day <= self.until:
                self._land_day(summary, scope, day, clock)
                day += timedelta(days=1)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        for failure in self.landing.flush():
            summary.fail(failure.endpoint, failure.key, failure.error)
        summary.pacing = self.client.pacing()
        return summary

    def _land_day(self, summary: RunSummary, scope: Scope, day: date, clock: datetime) -> None:
        names = history_names(day)
        published = report_time(names[0])
        key = published.strftime("%Y-%m-%dT%H-%M") if published else names[0]
        if self.landing.already_landed_today(scope, key) or self.landing.has_landed(scope, key):
            summary.record(None)
            return
        for name in names:
            url = PDF_BASE[self.league] + name
            try:
                response = self.client.get(url, headers=HEADERS)
            except CircuitOpenError:
                raise
            except Exception as exc:  # one bad day never stops the run
                summary.fail(ENDPOINT, key, exc)
                return
            if response.status_code in (403, 404):
                continue
            if response.status_code != 200:
                summary.fail(ENDPOINT, key, RuntimeError(f"HTTP {response.status_code}"))
                return
            try:
                rows = parse_report(response.content)
            except Exception as exc:
                summary.fail(ENDPOINT, key, exc)
                return
            payload = {
                "league": self.league,
                "report": name,
                "published_et": published.isoformat() if published else None,
                "url": url,
                "pdf_sha256": payload_hash(response.content),
                "rows": rows,
            }
            body = json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8")
            result = self.landing.land(
                scope, key, body, url=url, params={}, status=200, fetched_at=clock
            )
            summary.games += len({r["matchup"] for r in rows if r["matchup"]})
            summary.record(result)
            return
        # No report that day: nothing to land.
