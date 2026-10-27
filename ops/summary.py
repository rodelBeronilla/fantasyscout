"""Print an ops table from the lakehouse after a build, so the job log carries the numbers.

    uv run python -m ops.summary --engine databricks --table ops.reconciliation_summary
    uv run python -m ops.summary --engine duckdb --duckdb dbt/fantasyscout.duckdb

Used by the build workflow to report the reconciliation match and conflict rates per league
and season (SPEC.md phase 4) until Data Health shows them, and by the "Query the lakehouse"
workflow to look at any table (``--where``, ``--order-by``, ``--limit``).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from ops.results import _databricks_client, _run_statement

DEFAULT_COLUMNS = (
    "league, season, player_games, matched, unmatched, match_rate, "
    "played_player_games, played_matched, played_match_rate, "
    "exact, minor, conflict, conflict_rate"
)


def render(columns: list[str], rows: list[list[object]], *, limit: int = 200) -> list[str]:
    """A plain text table, one row per line, numbers rounded for reading."""

    def cell(value: object) -> str:
        if value is None:
            return ""
        if isinstance(value, float):
            return f"{value:.4f}"
        text = str(value)
        try:
            number = float(text)
        except ValueError:
            return text
        return f"{number:.4f}" if "." in text else text

    lines = ["    " + " | ".join(columns)]
    lines.extend("    " + " | ".join(cell(v) for v in row) for row in rows[:limit])
    if len(rows) > limit:
        lines.append(f"    ... {len(rows) - limit} more")
    return lines


def query_duckdb(path: Path, statement: str) -> tuple[list[str], list[list[object]]]:
    import duckdb  # local engine only

    con = duckdb.connect(str(path), read_only=True)
    try:
        rel = con.sql(statement)
        return list(rel.columns), [list(r) for r in rel.fetchall()]
    finally:
        con.close()


def query_databricks(
    statement: str, *, origin: str, token: str, warehouse_id: str, catalog: str
) -> tuple[list[str], list[list[object]]]:
    body = _run_statement(
        _databricks_client(origin, token),
        warehouse_id=warehouse_id,
        catalog=catalog,
        statement=statement,
    )
    manifest = body.get("manifest")
    schema = manifest.get("schema", {}) if isinstance(manifest, dict) else {}
    columns = [str(c["name"]) for c in schema.get("columns", [])]
    result = body.get("result")
    data = result.get("data_array", []) if isinstance(result, dict) else []
    return columns, [list(r) for r in data]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print an ops table after a build.")
    parser.add_argument("--engine", choices=("duckdb", "databricks"), required=True)
    parser.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    parser.add_argument("--catalog", default="fantasyscout")
    parser.add_argument("--table", default="ops.reconciliation_summary")
    parser.add_argument("--columns", default=DEFAULT_COLUMNS)
    parser.add_argument("--order-by", default="league, season")
    parser.add_argument("--where", default="", help="filter, SQL without the keyword")
    parser.add_argument("--limit", type=int, default=200, help="maximum rows printed")
    args = parser.parse_args(argv)

    statement = f"select {args.columns} from {args.table}"
    if args.where.strip():
        statement += f" where {args.where}"
    statement += f" order by {args.order_by} limit {max(args.limit, 1)}"
    try:
        if args.engine == "duckdb":
            columns, rows = query_duckdb(args.duckdb, statement)
        else:
            columns, rows = query_databricks(
                statement,
                origin=os.environ["DATABRICKS_ORIGIN"],
                token=os.environ["DATABRICKS_TOKEN"],
                warehouse_id=os.environ["DATABRICKS_WAREHOUSE_ID"],
                catalog=args.catalog,
            )
    except Exception as exc:
        print(f"{args.table}: unavailable ({type(exc).__name__}: {str(exc)[:200]})")
        return 0
    print(f"{args.table} ({len(rows)} rows):")
    for line in render(columns, rows, limit=max(args.limit, 1)):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
