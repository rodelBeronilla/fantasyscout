"""How many of the top 130 a Monday's build lists out or doubtful, and when its listing was fetched.

    uv run python -m ops.listing_counts --landing landing/ --league nba --season 2026-27 \
        --mondays 2026-10-26 2026-11-02 --out listing-counts.json

For #1140 (the morning cut) and #1096 (the live-week judge). It writes counts and fetch times
only, never a board, a player or a week's result. For each Monday:

- ESPN's listing landed that day: when it was fetched (the sidecar's ``fetched_at``), the time ESPN
  put on the answer (the file's ``timestamp``, which the morning cut reads), and how many players
  it lists out or doubtful, league-wide;
- per mirrored season, the official reports landed and how many were published on their own day
  before the morning cut (the only reports the morning cut adds to a build);
- the point-in-time build as of the Monday: which ESPN landing it reads, and how many of the top
  130 by value with a game that week (S0's population) its board lists out or doubtful, how many
  of those by the official report.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from datetime import UTC, date, datetime, time
from pathlib import Path
from typing import Any

import duckdb

from ops import walk_forward
from ops.closeness_backtest import LISTED_OUT
from ops.standings import CATS
from ops.week_yardstick import population

ESPN_OUT = ("Out", "Doubtful")
# the morning cut, as dbt/macros/point_in_time.sql states it (#1140)
MORNING_CUT = time(12, 0)


def espn_landing(root: Path, league: str, season: str, day: date) -> dict[str, Any]:
    """The ESPN listing landed on ``day``: its fetch time, ESPN's time and the count listed."""
    folder = root / "landing" / "espn" / "injuries" / league / season / day.isoformat()
    payload, meta = folder / "league.json", folder / "league.meta.json"
    row: dict[str, Any] = {"landed": payload.exists()}
    if payload.exists():
        body = json.loads(payload.read_text(encoding="utf-8"))
        listed = [
            i["status"] for team in body.get("injuries", []) for i in team.get("injuries", [])
        ]
        row["espn_timestamp"] = body.get("timestamp")
        row["league_wide_out_or_doubtful"] = sum(s in ESPN_OUT for s in listed)
    if meta.exists():
        row["fetched_at"] = json.loads(meta.read_text(encoding="utf-8")).get("fetched_at")
    return row


def board_counts(db: Path, league: str) -> dict[str, Any]:
    with duckdb.connect(str(db), read_only=True) as con:
        df = con.execute(
            f"select b.games_this_week, b.injury_group, s.official_status, {', '.join(CATS)}"
            " from gold.mart_board as b left join gold.fct_player_status as s"
            " on s.league = b.league and s.stats_player_id = b.player_id where b.league = ?",
            [league],
        ).fetchdf()
        read = con.execute(
            "select max(_ingest_date) from gold.fct_availability where league = ? and is_current",
            [league],
        ).fetchone()
    value = df[list(CATS)].astype(float).fillna(0).to_numpy().sum(axis=1)
    keep = population(value, df["games_this_week"].astype(float).fillna(0).to_numpy())
    top = df.iloc[keep]
    listed = top["injury_group"].isin(LISTED_OUT)
    return {
        "espn_landing_read": str(read[0]) if read and read[0] is not None else None,
        "board_players": len(df),
        "population": len(top),
        "out_or_doubtful": int(listed.sum()),
        "by_the_official_report": int(
            (listed & top["official_status"].isin(("Out", "Doubtful"))).sum()
        ),
    }


def early_reports(root: Path, league: str) -> dict[str, dict[str, int]]:
    """Per mirrored season, the official reports landed and how many were published on their day
    before the morning cut (12:00 UTC): the only reports the morning cut reads that a cut at the
    start of the day did not."""
    out: dict[str, dict[str, int]] = {}
    base = root / "landing" / "league" / "injury_report" / league
    for season in sorted(base.glob("*")) if base.exists() else []:
        total = early = 0
        for f in season.glob("*/*.json"):
            if f.name.endswith(".meta.json"):
                continue
            published = json.loads(f.read_text(encoding="utf-8")).get("published_et")
            if not published:
                continue
            total += 1
            moment = datetime.fromisoformat(published)
            cut = datetime.combine(moment.date(), MORNING_CUT, tzinfo=UTC)
            early += moment < cut
        out[season.name] = {"reports": total, "before_the_morning_cut": early}
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ops.listing_counts")
    p.add_argument("--landing", type=Path, required=True)
    p.add_argument("--league", required=True)
    p.add_argument("--season", required=True)
    p.add_argument("--mondays", nargs="+", type=date.fromisoformat, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args(argv)
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for monday in args.mondays:
            db = Path(tmp) / f"monday-{monday.isoformat()}.duckdb"
            walk_forward._build(monday, db)
            row = {
                "monday": monday.isoformat(),
                "espn_landing": espn_landing(args.landing, args.league, args.season, monday),
                "build": board_counts(db, args.league),
            }
            db.unlink()
            print(json.dumps(row), flush=True)
            out.append(row)
    reports = early_reports(args.landing, args.league)
    print(json.dumps({"official_reports": reports}), flush=True)
    result = {"mondays": out, "official_reports": reports}
    args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
