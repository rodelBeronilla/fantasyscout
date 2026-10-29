from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.http import Throttle, ThrottledClient
from ingest.injury_report import (
    InjuryReportIngestor,
    latest_in_index,
    parse_report,
    report_name,
    report_time,
)
from ingest.store import Landing, LocalBackend

FIXTURES = Path(__file__).parent / "fixtures" / "league"
NBA_PDF = (FIXTURES / "nba_injury_report.pdf").read_bytes()
WNBA_PDF = (FIXTURES / "wnba_injury_report.pdf").read_bytes()


def client_for(handler) -> ThrottledClient:  # type: ignore[no-untyped-def]
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def test_report_names_round_trip_through_eastern_time() -> None:
    at = report_time("Injury-Report_2026-10-29_06_45PM.pdf")
    assert at is not None and (at.hour, at.minute) == (18, 45)
    assert report_name(at) == "Injury-Report_2026-10-29_06_45PM.pdf"
    assert report_time("not-a-report.pdf") is None


def test_the_newest_report_on_the_index_page_wins() -> None:
    html = " ".join(
        f'<a href="https://ak-static.cms.nba.com/referee/injury/{n}">x</a>'
        for n in [
            "Injury-Report_2026-10-29_12_45PM.pdf",
            "Injury-Report_2026-10-29_06_45PM.pdf",
            "Injury-Report_2026-10-28_11_45PM.pdf",
        ]
    )
    assert latest_in_index(html) == "Injury-Report_2026-10-29_06_45PM.pdf"
    assert latest_in_index("<html></html>") is None


def test_an_nba_report_parses_into_players_with_wrapped_reasons_put_back_together() -> None:
    rows = parse_report(NBA_PDF)
    assert len(rows) == 100
    first = rows[0]
    assert first == {
        "game_date": "10/29/2026",
        "game_time_et": "08:00",
        "matchup": "CLE@ATL",
        "team": "Cleveland Cavaliers",
        "player_name": "Khalifa Diop",
        "player_name_listed": "Diop, Khalifa",
        "status": "Out",
        "reason": "G League - On Assignment",
        "not_submitted": False,
    }
    by_name = {r["player_name"]: r for r in rows if r["player_name"]}
    # A reason that wraps sits half above and half below the player's line.
    assert by_name["Meleek Thomas"]["reason"] == "Injury/Illness - Right Foot Inflammation/Soreness"
    assert by_name["Nae'Qwan Tomlin"]["reason"] == "Injury/Illness - Low Back Stress Reaction"
    assert (
        by_name["Zuby Ejiofor"]["status"] == "Available"
        and by_name["Zuby Ejiofor"]["reason"] is None
    )
    assert by_name["RayJ Dennis"]["team"] == "Atlanta Hawks"
    pending = [r for r in rows if r["not_submitted"]]
    assert {r["team"] for r in pending} >= {"Los Angeles Lakers", "Golden State Warriors"}
    assert all(r["player_name"] is None and r["status"] is None for r in pending)
    assert {r["status"] for r in rows if r["status"]} <= {
        "Out",
        "Doubtful",
        "Questionable",
        "Probable",
        "Available",
    }


def test_a_wnba_report_parses_the_same_way_across_pages() -> None:
    rows = parse_report(WNBA_PDF)
    assert len(rows) == 22
    by_name = {r["player_name"]: r for r in rows if r["player_name"]}
    assert by_name["Caitlin Clark"]["matchup"] == "IND@SEA"
    assert by_name["Caitlin Clark"]["status"] == "Probable"
    # Page two has no header row: the columns and the game carry over from page one.
    assert by_name["Cheyenne Parker-Tyus"] == {
        **by_name["Cheyenne Parker-Tyus"],
        "team": "Las Vegas Aces",
        "matchup": "PDX@LVA",
        "status": "Out",
        "reason": "Concussion Protocol",
    }


def test_the_nba_run_lands_the_newest_report_once_a_day(tmp_path: Path) -> None:
    calls: list[str] = []
    name = "Injury-Report_2026-10-29_06_45PM.pdf"

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.host == "official.nba.com":
            return httpx.Response(200, text=f'<a href="/referee/injury/{name}">latest</a>')
        return httpx.Response(200, content=NBA_PDF)

    now = datetime(2026, 10, 29, 23, 5, tzinfo=UTC)

    def run() -> object:
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        return InjuryReportIngestor(client_for(handler), landing, "nba", "2026-27", now=now).run()

    first = run()
    assert first.ok and first.landed == 1 and first.games == 13  # type: ignore[attr-defined]
    assert calls == ["/nba-injury-report-2026-27-season/", f"/referee/injury/{name}"]
    landed = next(
        (tmp_path / "landing/league/injury_report/nba/2026-27").rglob("2026-10-29T18-45.json")
    )
    payload = json.loads(landed.read_text(encoding="utf-8"))
    assert payload["report"] == name and len(payload["rows"]) == 100
    assert payload["published_et"] == "2026-10-29T18:45:00-04:00"

    calls.clear()
    again = run()
    assert again.ok and again.landed == 0 and again.skipped == 1  # type: ignore[attr-defined]
    assert calls == ["/nba-injury-report-2026-27-season/"], "the PDF is not fetched twice in a day"


def test_the_wnba_run_finds_the_newest_report_by_trying_recent_quarter_hours(
    tmp_path: Path,
) -> None:
    tried: list[str] = []
    found = "Injury-Report_2026-07-27_08_00PM.pdf"

    def handler(request: httpx.Request) -> httpx.Response:
        tried.append(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, content=WNBA_PDF) if tried[-1] == found else httpx.Response(404)

    now = datetime(2026, 7, 28, 0, 40, tzinfo=UTC)  # 8:40 PM Eastern
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    summary = InjuryReportIngestor(client_for(handler), landing, "wnba", "2026", now=now).run()
    assert summary.ok and summary.landed == 1
    assert tried == [
        "Injury-Report_2026-07-27_08_30PM.pdf",
        "Injury-Report_2026-07-27_08_15PM.pdf",
        "Injury-Report_2026-07-27_08_00PM.pdf",
    ], "the probe walks back a quarter hour at a time and reuses the PDF it found"


def test_out_of_season_the_wnba_run_asks_for_nothing(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"no request expected, got {request.url}")

    now = datetime(2026, 12, 1, 12, tzinfo=UTC)
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    summary = InjuryReportIngestor(client_for(handler), landing, "wnba", "2026", now=now).run()
    assert summary.ok and summary.landed == 0
