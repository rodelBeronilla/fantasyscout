"""Team payrolls: the salary table is read, each team lands once, politely identified (#772)."""

from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.bref import TEAMS, USER_AGENT, BrefSalariesIngestor, bref_year, parse_salaries
from ingest.http import Throttle, ThrottledClient
from ingest.store import Landing, LocalBackend

# A page shaped like a team page: the salary table sits inside an HTML comment.
ROWS = (
    '<tr><th scope="row">1</th><td data-append-csv="haywago01">'
    '<a href="/players/h/haywago01.html">Gordon Hayward</a></td><td>$31,214,295</td></tr>'
    '<tr><th scope="row">2</th><td data-append-csv="doejo01">'
    '<a href="/players/d/doejo01.html">Jo&atilde;o Doe</a></td><td></td></tr>'
)
PAGE = (
    '<html><body><div id="all_salaries2"><!--'
    '<table class="sortable stats_table" id="salaries2">'
    "<thead><tr><th>Rk</th><th>Player</th><th>Salary</th></tr></thead>"
    f"<tbody>{ROWS}</tbody></table>"
    "--></div></body></html>"
)


def test_the_salary_table_is_read_from_inside_its_comment() -> None:
    assert bref_year("2018-19") == "2019"
    assert parse_salaries(PAGE) == [
        {"bref_player_id": "haywago01", "name": "Gordon Hayward", "salary": 31214295},
        {"bref_player_id": "doejo01", "name": "João Doe", "salary": None},
    ]
    assert parse_salaries("<html>no table</html>") == []


def _client(handler: httpx.MockTransport) -> ThrottledClient:
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=handler,
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def test_a_season_lands_each_team_once_and_identifies_itself(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "/teams/OKC/" in request.url.path:
            return httpx.Response(404)
        return httpx.Response(200, text=PAGE)

    client = _client(httpx.MockTransport(handler))
    now = datetime(2026, 11, 7, 21, tzinfo=UTC)
    for _ in range(2):
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        summary = BrefSalariesIngestor(client, landing, "nba", "2018-19", now=now).run()
    assert len(seen) == len(TEAMS) + 1, "29 teams land once; the missing one is asked again"
    assert seen[0].url.path == "/teams/ATL/2019.html"
    assert all(r.headers["User-Agent"] == USER_AGENT for r in seen)
    assert not summary.failures
    [boston] = (tmp_path / "landing/bref/salaries/nba/2018-19").rglob("BOS.json")
    body = json.loads(boston.read_text(encoding="utf-8"))
    assert body["rows"][0]["salary"] == 31214295 and body["year"] == "2019"


def test_the_wnba_asks_for_nothing(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=PAGE)

    landing = Landing(LocalBackend(tmp_path), ingest_date=datetime(2026, 11, 7).date())
    BrefSalariesIngestor(_client(httpx.MockTransport(handler)), landing, "wnba", "2025").run()
    assert seen == []
