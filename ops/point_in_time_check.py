"""Prove a point-in-time build cuts exactly what came after its date, and nothing before (#752).

    uv run python -m ops.point_in_time_check   # after the sample build (dbt/fantasyscout.duckdb)

Rebuilds the lakehouse from scratch twice into new DuckDB files, with ``point_in_time: true``:

- as of the sample's first game day: no dated table may hold a row on or after it, and a source
  that keeps only its newest file must be empty;
- as of the day after its last game: still no row on or after it, and every event table must
  keep every row the full build has before it, so an over-cut (a game log cut by the day a
  backfill landed it) fails too.

A dated table or column the build lacks is a failure, not a skip; a table the sample leaves empty
is named, since it proves nothing. Exits 1 on any failure.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DBT = ROOT / "dbt"

# Each dated table and the column that says when its row was known.
DATED: tuple[tuple[str, str], ...] = (
    ("silver.team_game_box", "game_date"),
    ("silver.games", "game_date"),
    ("silver.official_injury_report", "published_at_et"),
    ("silver.injuries", "report_date"),
    ("silver.injury_status_history", "status_to"),
    ("silver.espn_fantasy_market", "observed_date"),
    ("silver.game_lines", "observed_date"),
    ("silver.standings", "observed_date"),
    ("silver.transactions", "transaction_date"),
    ("silver.rosters", "_ingest_date"),
    ("silver.starting_lineups", "game_date"),
    ("gold.fct_player_game", "game_date"),
    ("gold.fct_team_game", "game_date"),
    ("gold.fct_shot", "game_date"),
    ("gold.fct_event", "game_date"),
    ("gold.fct_player_tracking", "game_date"),
    ("gold.fct_game_official", "game_date"),
    ("gold.fct_availability", "report_date"),
    ("gold.fct_transaction", "transaction_date"),
    ("gold.fct_player_prop", "snapshot_at"),
    ("gold.int_player_game_value", "game_date"),
    ("gold.mart_player_rolling", "game_date"),
    ("gold.fct_official_listing", "game_date"),
    ("gold.fct_injury_spell", "start_date"),
    ("gold.fct_injury_spell", "return_date"),
    ("gold.fct_absence_spell", "start_date"),
    ("gold.fct_absence_spell", "return_date"),
)
# Records of games, cut by the day they were played: everything before the date must survive.
EVENTS: frozenset[str] = frozenset(
    {
        "silver.team_game_box",
        "silver.games",
        "gold.fct_player_game",
        "gold.fct_team_game",
        "gold.fct_shot",
        "gold.fct_event",
        "gold.fct_player_tracking",
        "gold.fct_game_official",
        "gold.int_player_game_value",
        "gold.mart_player_rolling",
    }
)
# Sources that keep only their newest file hold nothing about an earlier day.
EMPTY: tuple[str, ...] = ("gold.fct_waiver_trend",)


def _columns(con: duckdb.DuckDBPyConnection, table: str) -> set[str]:
    schema, name = table.split(".")
    rows = con.execute(
        "select column_name from information_schema.columns"
        " where table_schema = ? and table_name = ?",
        [schema, name],
    ).fetchall()
    return {r[0] for r in rows}


def _count(con: duckdb.DuckDBPyConnection, sql: str, params: list[object] | None = None) -> int:
    row = con.execute(sql, params or []).fetchone()
    return int(row[0]) if row else 0


def leaks(con: duckdb.DuckDBPyConnection, as_of: date) -> list[str]:
    """Every dated row on or after ``as_of``, every non-empty newest-only source, and every
    dated table or column the build lacks."""
    found: list[str] = []
    for table, col in DATED:
        if col not in _columns(con, table):
            found.append(f"{table}.{col}: missing from the build")
            continue
        n = _count(con, f"select count(*) from {table} where cast({col} as date) >= ?", [as_of])
        if n:
            found.append(f"{table}: {n} rows with {col} on or after {as_of}")
    for table in EMPTY:
        if not _columns(con, table):
            found.append(f"{table}: missing from the build")
        elif n := _count(con, f"select count(*) from {table}"):
            found.append(f"{table}: {n} rows, but it keeps only its newest file")
    return found


def dropped(
    cut: duckdb.DuckDBPyConnection, full: duckdb.DuckDBPyConnection, as_of: date
) -> list[str]:
    """Event tables that lost rows from before ``as_of``: the cut reached too far back."""
    found: list[str] = []
    for table, col in DATED:
        if table not in EVENTS:
            continue
        sql = f"select count(*) from {table} where cast({col} as date) < ?"
        want, got = _count(full, sql, [as_of]), _count(cut, sql, [as_of])
        if got != want:
            found.append(f"{table}: {got} rows before {as_of}, the full build has {want}")
    return found


def idle(full: duckdb.DuckDBPyConnection) -> list[str]:
    """Checked tables the sample leaves empty: they prove nothing either way."""
    return [
        t
        for t in dict.fromkeys(t for t, _ in DATED)
        if _count(full, f"select count(*) from {t}") == 0
    ]


def _build(as_of: date, db: Path) -> str | None:
    env = {**os.environ, "DBT_DUCKDB_PATH": str(db), "DBT_PROFILES_DIR": "."}
    cmd = [
        "dbt", "build", "--target", "duckdb", "--full-refresh", "--exclude", "tag:quality",
        # the unit tests pin as_of and point_in_time for their own cases
        "--exclude-resource-type", "unit_test",
        "--vars", f"{{as_of: '{as_of.isoformat()}', point_in_time: true}}",
    ]  # fmt: skip
    run = subprocess.run(cmd, cwd=DBT, env=env, capture_output=True, text=True, check=False)
    if run.returncode != 0:
        tail = f"{run.stdout[-3000:]}\n{run.stderr[-1000:]}"
        return f"the point-in-time build as of {as_of} failed:\n{tail}"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample-db", default=str(DBT / "fantasyscout.duckdb"))
    args = parser.parse_args(argv)

    with duckdb.connect(args.sample_db, read_only=True) as full:
        span = full.execute(
            "select min(game_date), max(game_date) from gold.fct_player_game"
        ).fetchone()
        if not span or span[0] is None:
            print("the sample build has no games: nothing to check", file=sys.stderr)
            return 1
        first, after_last = span[0], span[1] + timedelta(days=1)
        problems: list[str] = []
        with tempfile.TemporaryDirectory() as tmp:
            for as_of, keep in ((first, False), (after_last, True)):
                db = Path(tmp) / f"pit-{as_of.isoformat()}.duckdb"
                if err := _build(as_of, db):
                    problems.append(err)
                    continue
                with duckdb.connect(str(db), read_only=True) as cut:
                    problems += leaks(cut, as_of)
                    if keep:
                        problems += dropped(cut, full, as_of)
        unexercised = idle(full)

    if problems:
        print("point-in-time check failed:", *problems, sep="\n  ", file=sys.stderr)
        return 1
    print(
        f"point-in-time builds as of {first} and {after_last}: nothing from on or after the date,"
        f" every earlier game kept ({len({t for t, _ in DATED})} tables checked)"
    )
    if unexercised:
        print("not exercised by the sample (no rows):", ", ".join(unexercised))
    return 0


if __name__ == "__main__":
    sys.exit(main())
