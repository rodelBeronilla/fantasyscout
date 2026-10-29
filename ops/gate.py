"""Check the latest publish gate before exporting by hand.

    uv run python -m ops.gate --engine databricks
    uv run python -m ops.gate --engine duckdb --duckdb dbt/fantasyscout.duckdb

Exit status 0 when the most recent row of ops.publish_gate passed, 2 when it was blocked or
there is no gate yet. The nightly build exports only after its own gate passes; the Export
workflow runs this first so a hand-made build cannot publish what a failed build left behind.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from ops.summary import query_databricks, query_duckdb

STATEMENT = (
    "select run_id, run_at, passed, error_failures, model_errors, reason "
    "from {schema}.publish_gate order by run_at desc limit 1"
)


def decide(columns: list[str], rows: list[list[object]]) -> tuple[bool, str]:
    """Whether the latest gate passed, and a line saying so."""
    if not rows:
        return False, "no publish gate recorded yet: run the Build lakehouse workflow first"
    row = dict(zip(columns, rows[0], strict=False))
    passed = str(row.get("passed")).lower() in ("true", "1")
    state = "passed" if passed else "blocked"
    detail = f"run {row.get('run_id')} at {row.get('run_at')}: {state}"
    if not passed:
        detail += f" ({row.get('reason') or 'see ops.test_results'})"
    return passed, f"latest publish gate, {detail}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--engine", choices=("duckdb", "databricks"), required=True)
    parser.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    parser.add_argument("--schema", default="ops")
    parser.add_argument("--catalog", default="fantasyscout")
    args = parser.parse_args(argv)

    statement = STATEMENT.format(schema=args.schema)
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
    passed, line = decide(columns, rows)
    print(line)
    if not passed:
        print("::error::the latest publish gate did not pass; not exporting")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
