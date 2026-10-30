from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.http import Throttle, ThrottledClient
from ingest.referee_assignments import (
    URL,
    RefereeAssignmentsIngestor,
    parse_assignments,
    parse_official,
)
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend

PAGE = (Path(__file__).parent / "fixtures" / "league" / "referee_assignments.html").read_text(
    encoding="utf-8"
)
# 11 am Eastern on the day the fixture was captured.
MORNING = datetime(2026, 10, 30, 15, tzinfo=UTC)


def client_for(handler) -> ThrottledClient:  # type: ignore[no-untyped-def]
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def run_at(tmp_path: Path, now: datetime, handler, league: str = "nba") -> RunSummary:  # type: ignore[no-untyped-def]
    season = "2026-27" if league == "nba" else "2026"
    summary = RunSummary("league", league, season, now)  # type: ignore[arg-type]
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    RefereeAssignmentsIngestor(client_for(handler), landing, league, season, now=now).land_into(  # type: ignore[arg-type]
        summary
    )
    landing.flush()
    return summary


def test_the_page_parses_into_one_row_per_game_with_each_role() -> None:
    parsed = parse_assignments(PAGE)
    nba = parsed["nba"]
    assert nba["date"] == "2026-10-30"
    assert [r["game"] for r in nba["rows"]] == [
        "Chicago @ Boston",
        "Houston @ Dallas",
        "LA Clippers @ Minnesota",
        "L.A. Lakers @ Golden State",
    ]
    lakers = nba["rows"][3]
    assert lakers == {
        "game": "L.A. Lakers @ Golden State",
        "away_team": "L.A. Lakers",
        "home_team": "Golden State",
        "crew_chief": "Tony Brothers",
        "crew_chief_number": 25,
        "referee": "John Butler",
        "referee_number": 30,
        "umpire": "Jenna Schroeder",
        "umpire_number": 20,
        "alternate": None,
        "alternate_number": None,
    }
    # The replay center's officials are not a game's crew.
    assert all("Dedric Taylor" not in json.dumps(r) for r in nba["rows"])
    # An off day: the WNBA's table is there but empty.
    assert parsed["wnba"] == {"date": "2026-10-30", "rows": []}


def test_a_page_without_tables_parses_to_nothing() -> None:
    assert parse_assignments("<html><body><p>No games scheduled.</p></body></html>") == {}


def test_an_official_cell_splits_name_and_number() -> None:
    assert parse_official("  Ashley Moyer-Gleich (#13) ") == ("Ashley Moyer-Gleich", 13)
    assert parse_official("JB DeRosa") == ("JB DeRosa", None)
    assert parse_official("   ") == (None, None)


def test_the_rows_land_once_per_eastern_day(tmp_path: Path) -> None:
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        return httpx.Response(200, text=PAGE)

    first = run_at(tmp_path, MORNING, handler)
    assert first.ok and first.landed == 1
    again = run_at(tmp_path, datetime(2026, 10, 30, 23, tzinfo=UTC), handler)
    assert again.ok and again.landed == 0
    assert urls == [URL]  # the evening run asks for nothing
    files = [
        p
        for p in (tmp_path / "landing/league/referee_assignments/nba/2026-27").rglob("*.json")
        if ".meta" not in p.name and not p.name.startswith("_")
    ]
    assert [p.name for p in files] == ["2026-10-30.json"]
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assert payload["page_date"] == "2026-10-30" and len(payload["rows"]) == 4
    assert b"<table" not in files[0].read_bytes()


def test_an_empty_table_or_a_failed_page_records_nothing_and_never_raises(tmp_path: Path) -> None:
    quiet = run_at(tmp_path, MORNING, lambda r: httpx.Response(200, text=PAGE), league="wnba")
    assert quiet.ok and quiet.landed == 0
    assert not (tmp_path / "landing/league/referee_assignments/wnba").exists()

    down = run_at(tmp_path, MORNING, lambda r: httpx.Response(503), league="wnba")
    assert not down.ok and down.landed == 0
