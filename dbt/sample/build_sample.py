"""Build a tiny landing directory from the recorded fixtures so dbt can run without the cloud.

    uv run python dbt/sample/build_sample.py

Writes dbt/sample/landing/... in the exact layout the ingestors use (payload plus sidecar).
Re-run it whenever a fixture changes; the output is committed.
"""

from __future__ import annotations

import json
import shutil
from datetime import UTC, date, datetime
from pathlib import Path

from ingest.landing import Sidecar, landing_key

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT.parent.parent / "tests" / "fixtures"
INGEST_DATE = date(2026, 10, 27)
FETCHED_AT = datetime(2026, 10, 27, 9, 15, tzinfo=UTC)

# (source, endpoint, fixture name, league, season, key)
PAYLOADS = [
    ("stats", "leaguegamelog", "leaguegamelog", "wnba", "2026", "team-regular-season"),
    ("stats", "scheduleleaguev2", "scheduleleaguev2", "wnba", "2026", "season"),
    ("stats", "commonallplayers", "commonallplayers", "wnba", "2026", "season"),
    ("stats", "boxscoretraditionalv3", "boxscoretraditionalv3", "wnba", "2026", "1022600330"),
    ("stats", "boxscoreadvancedv3", "boxscoreadvancedv3", "wnba", "2026", "1022600330"),
    ("stats", "playbyplayv3", "playbyplayv3", "wnba", "2026", "1022600330"),
    ("stats", "shotchartdetail", "shotchartdetail", "wnba", "2026", "1022600330"),
    ("stats", "playergamelogs", "playergamelogs", "wnba", "2026", "advanced-regular-season"),
    ("stats", "commonteamroster", "commonteamroster", "wnba", "2026", "1611661319"),
    ("espn", "scoreboard", "scoreboard", "wnba", "2026", "20260924"),
    ("espn", "summary", "summary", "wnba", "2026", "401736337"),
    ("espn", "teams", "teams", "wnba", "2026", "league"),
    ("espn", "roster", "roster", "wnba", "2026", "17"),
    ("espn", "injuries", "injuries", "wnba", "2026", "league"),
    ("league", "injury_report", "injury_report", "wnba", "2026", "2026-07-27T20-00"),
    ("league", "daily_lineups", "daily_lineups", "nba", "2026-27", "2026-10-29T19"),
    ("espn", "transactions", "transactions", "wnba", "2026", "2026-10-29"),
    ("league", "player_movement", "player_movement", "nba", "2026-27", "2026-10-29"),
]


def main() -> None:
    out = ROOT / "landing"
    if out.exists():
        shutil.rmtree(out)
    for source, endpoint, fixture, league, season, key in PAYLOADS:
        body = (FIXTURES / source / f"{fixture}.json").read_bytes()
        if source == "espn" and endpoint == "summary":
            key = json.loads(body)["header"]["id"]
        if source == "espn" and endpoint == "roster":
            key = json.loads(body)["team"]["id"]
        rel = landing_key(source, endpoint, league, season, INGEST_DATE, key)  # type: ignore[arg-type]
        target = ROOT / Path(*rel.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        sidecar = Sidecar.for_response(
            url=f"https://example.invalid/{source}/{endpoint}",
            params={},
            status=200,
            body=body,
            fetched_at=FETCHED_AT,
        )
        target.with_suffix(".meta.json").write_text(
            sidecar.model_dump_json(indent=2) + "\n", encoding="utf-8"
        )
        print("wrote", target.relative_to(ROOT))


if __name__ == "__main__":
    main()
