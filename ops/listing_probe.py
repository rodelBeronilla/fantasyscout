"""Can a Monday morning's injury listing be rebuilt later? (#1096, a probe, not a study)

    uv run python -m ops.listing_probe --landing landing/ --league nba --season 2026-27 \
        --mondays 2026-11-09 2026-11-16 --out probe.json

Reads the mirrored landing and point-in-time builds only; writes listing counts, never a week's
results. For each Monday:

- the ESPN injuries landings around it: the ingest date folder, when it was fetched (sidecar), and
  how many players ESPN lists out or doubtful;
- the official reports landed for the Monday and the Sunday before: each report's name, when it
  was published, and the folder it landed in;
- the point-in-time build as of the Monday and as of the Tuesday: the top 130 by value with a game
  that week (S0's population) on the Monday's board, how many the board lists out or doubtful, and
  how many ESPN's own listing in each build has out or doubtful, with the ESPN landing date each
  build reads.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import duckdb
import numpy as np

from ops import walk_forward
from ops.closeness_backtest import LISTED_OUT
from ops.standings import CATS
from ops.week_yardstick import population

ESPN_OUT = ("Out", "Doubtful")


def espn_landings(root: Path, league: str, season: str, days: list[date]) -> list[dict[str, Any]]:
    out = []
    for d in days:
        folder = root / "espn" / "injuries" / league / season / d.isoformat()
        payload, meta = folder / "league.json", folder / "league.meta.json"
        row: dict[str, Any] = {"ingest_date": d.isoformat(), "landed": payload.exists()}
        if payload.exists():
            body = json.loads(payload.read_text(encoding="utf-8"))
            listed = [
                i["status"] for team in body.get("injuries", []) for i in team.get("injuries", [])
            ]
            row["espn_timestamp"] = body.get("timestamp")
            row["listed"] = len(listed)
            row["out_or_doubtful"] = sum(s in ESPN_OUT for s in listed)
        if meta.exists():
            row["fetched_at"] = json.loads(meta.read_text(encoding="utf-8")).get("fetched_at")
        out.append(row)
    return out


def official_reports(
    root: Path, league: str, season: str, days: list[date]
) -> list[dict[str, Any]]:
    out = []
    base = root / "league" / "injury_report" / league / season
    for folder in sorted(base.glob("*")) if base.exists() else []:
        for f in sorted(folder.glob("*.json")):
            if f.name.endswith(".meta.json"):
                continue
            body = json.loads(f.read_text(encoding="utf-8"))
            published = str(body.get("published_et", ""))
            if any(published.startswith(d.isoformat()) for d in days):
                out.append(
                    {
                        "ingest_date": folder.name,
                        "report": body.get("report"),
                        "published_et": published,
                        "rows": len(body.get("rows", [])),
                    }
                )
    return out


def board(db: Path, league: str) -> dict[str, Any]:
    with duckdb.connect(str(db), read_only=True) as con:
        df = con.execute(
            f"select player_id, games_this_week, injury_group, {', '.join(CATS)}"
            " from gold.mart_board where league = ?",
            [league],
        ).fetchdf()
        espn = con.execute(
            "select stats_player_id as player_id, espn_status_group, official_status,"
            " official_report_at from gold.fct_player_status where league = ?",
            [league],
        ).fetchdf()
        current = con.execute(
            "select max(_ingest_date) from gold.fct_availability where league = ? and is_current",
            [league],
        ).fetchone()
    value = df[list(CATS)].astype(float).fillna(0).to_numpy().sum(axis=1)
    keep = population(value, df["games_this_week"].astype(float).fillna(0).to_numpy())
    return {
        "players": df["player_id"].astype(str).to_numpy()[keep].tolist(),
        "listed": df["injury_group"].isin(LISTED_OUT).to_numpy()[keep],
        "espn": dict(zip(espn["player_id"].astype(str), espn["espn_status_group"], strict=True)),
        "espn_current": str(current[0]) if current and current[0] is not None else None,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ops.listing_probe")
    p.add_argument("--landing", type=Path, required=True)
    p.add_argument("--league", required=True)
    p.add_argument("--season", required=True)
    p.add_argument("--mondays", nargs="+", type=date.fromisoformat, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args(argv)
    result = []
    with tempfile.TemporaryDirectory() as tmp:
        for monday in args.mondays:
            days = [monday + timedelta(days=k) for k in (-2, -1, 0, 1)]
            builds = {}
            for as_of in (monday, monday + timedelta(days=1)):
                db = Path(tmp) / f"b-{as_of.isoformat()}.duckdb"
                walk_forward._build(as_of, db)
                builds[as_of.isoformat()] = board(db, args.league)
                db.unlink()
            mon, tue = builds[monday.isoformat()], builds[(monday + timedelta(days=1)).isoformat()]
            pop = mon["players"]
            row = {
                "monday": monday.isoformat(),
                "espn_landings": espn_landings(args.landing, args.league, args.season, days),
                "official_reports": official_reports(
                    args.landing, args.league, args.season, days[1:3]
                ),
                "population": len(pop),
                "monday_build": {
                    "espn_landing_read": mon["espn_current"],
                    "board_out_or_doubtful": int(np.sum(mon["listed"])),
                    "espn_out_or_doubtful": sum(mon["espn"].get(x) in LISTED_OUT for x in pop),
                },
                "tuesday_build_on_mondays_players": {
                    "espn_landing_read": tue["espn_current"],
                    "espn_out_or_doubtful": sum(tue["espn"].get(x) in LISTED_OUT for x in pop),
                },
            }
            print(json.dumps(row, indent=1), flush=True)
            result.append(row)
    args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
