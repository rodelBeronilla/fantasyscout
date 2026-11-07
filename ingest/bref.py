"""NBA team payrolls by season from Basketball-Reference (#772), for the contract-year study.

The owner chose to collect these although Sports-Reference's terms ask that its pages not be
scraped, on the terms ADR 0008 sets for such a source (its addendum of 2026-11-07): a slow,
identified crawler that keeps to robots.txt and its crawl delay, credit on the Sources page, only
aggregates of the study published, and a stop, with the landed files deleted, if the operator
objects.

One page per team and season: ``/teams/<code>/<year>.html``, allowed by robots.txt, whose
``salaries2`` table lists each player's salary that season. A run asks for the 30 teams of one
season, at least four seconds apart (the site's crawl delay is three, its bot limit 20 a minute),
and lands each team's rows: the player's Basketball-Reference id, name and salary. The rest of
the page is not kept.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ingest.http import CircuitOpenError, Throttle, ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

SOURCE = "bref"
ENDPOINT = "salaries"
BASE = "https://www.basketball-reference.com/teams/{code}/{year}.html"
USER_AGENT = (
    "FantasyScout/1.0 (free, non-commercial fantasy research; "
    "+https://fantasyscout.beronilla.rodeo/sources/)"
)
# At least four seconds between requests, slowing to eight if the site strains (robots.txt asks
# for three; the bot policy blocks a client past 20 requests a minute).
THROTTLE = Throttle(min_gap=4.0, max_gap=8.0, start_gap=5.0, max_retries=2)

# Basketball-Reference's team codes; three franchises renamed or moved since 2018-19 keep their
# current code here (Brooklyn BRK, Charlotte CHO, Phoenix PHO are already the site's own).
TEAMS = (
    "ATL", "BOS", "BRK", "CHO", "CHI", "CLE", "DAL", "DEN", "DET", "GSW",
    "HOU", "IND", "LAC", "LAL", "MEM", "MIA", "MIL", "MIN", "NOP", "NYK",
    "OKC", "ORL", "PHI", "PHO", "POR", "SAC", "SAS", "TOR", "UTA", "WAS",
)  # fmt: skip

_TABLE = re.compile(r'<table[^>]*id="salaries2".*?</table>', re.S)
_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S)
_ID = re.compile(r'data-append-csv="([^"]+)"')


def bref_year(season: str) -> str:
    """Basketball-Reference names a season by the year it ends: 2018-19 is 2019."""
    return str(int(season[:4]) + 1)


def parse_salaries(page: str) -> list[dict[str, Any]]:
    """The salaries2 table's rows: the player's id, name and salary in dollars (None if blank)."""
    table = _TABLE.search(page)
    if not table:
        return []
    out: list[dict[str, Any]] = []
    for row in _ROW.findall(table.group(0)):
        pid = _ID.search(row)
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in _CELL.findall(row)]
        if not pid or len(cells) < 3:
            continue  # the header row, or a row without a player
        digits = re.sub(r"[^0-9]", "", cells[2])
        out.append(
            {
                "bref_player_id": pid.group(1),
                "name": cells[1],
                "salary": int(digits) if digits else None,
            }
        )
    return out


@dataclass
class BrefSalariesIngestor:
    """Lands one season's team payrolls, one landing per team, once."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def run(self) -> RunSummary:
        clock = self.now or datetime.now(UTC)
        summary = RunSummary(SOURCE, self.league, self.season, clock)
        if self.league != "nba":
            return summary  # Basketball-Reference has no WNBA payrolls
        scope = Scope(SOURCE, ENDPOINT, self.league, self.season)
        year = bref_year(self.season)
        try:
            for code in TEAMS:
                if self.landing.has_landed(scope, code):
                    summary.record(None)
                    continue
                url = BASE.format(code=code, year=year)
                try:
                    response = self.client.get(url, headers={"User-Agent": USER_AGENT})
                except CircuitOpenError:
                    raise
                except Exception as exc:  # one team never stops the run
                    summary.fail(ENDPOINT, code, exc)
                    continue
                if response.status_code == 404:
                    summary.record(None)  # a franchise that had another code that season
                    continue
                if response.status_code != 200:
                    summary.fail(ENDPOINT, code, RuntimeError(f"HTTP {response.status_code}"))
                    continue
                rows = parse_salaries(response.text)
                payload = {"team": code, "year": year, "url": url, "rows": rows}
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                result = self.landing.land(
                    scope, code, body, url=url, params={}, status=200, fetched_at=clock
                )
                summary.record(result)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        for failure in self.landing.flush():
            summary.fail(failure.endpoint, failure.key, failure.error)
        summary.pacing = self.client.pacing()
        return summary
