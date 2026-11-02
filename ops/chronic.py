"""Warn-severity checks that warned in every one of the last builds: the warnings nobody acts on.

    uv run python -m ops.chronic --engine databricks
    uv run python -m ops.chronic --engine duckdb --duckdb dbt/fantasyscout.duckdb

A warn-severity check publishes the build and is reported only in the log and on Data Health, so a
check that warns build after build reaches no one: the volume check warned twelve gates in a row
and the stale-feed check four, with no issue (#421). This reads ops.test_results, finds the warn
checks that warned in each of the last ``--runs`` builds (five by default), prints a GitHub warning
for each, and writes ``checks`` and ``detail`` to $GITHUB_OUTPUT and the detail to chronic.log for
the incident the build opens ("Build warnings that persist"); with none, the incident closes.
"""

from __future__ import annotations

import argparse
import os
from collections.abc import Callable
from pathlib import Path

from ops.summary import query_databricks, query_duckdb

RUNS = 5

Query = Callable[[str], tuple[list[str], list[list[object]]]]


def statement(schema: str = "ops", runs: int = RUNS) -> str:
    """The warn checks that warned (warn or fail) in each of the last ``runs`` builds."""
    return f"""
with recent as (
    select run_id
    from {schema}.test_results
    group by run_id
    order by max(run_at) desc
    limit {int(runs)}
),
counted as (
    select count(*) as n from recent
),
warned as (
    select t.check_name, count(distinct t.run_id) as builds, max(t.failures) as failures
    from {schema}.test_results as t
    join recent as r on r.run_id = t.run_id
    where t.severity = 'warn' and t.status in ('warn', 'fail')
    group by t.check_name
)
select w.check_name, w.failures
from warned as w
cross join counted as c
where c.n = {int(runs)} and w.builds = c.n
order by w.check_name
"""


def chronic(query: Query, schema: str = "ops", runs: int = RUNS) -> list[tuple[str, int]]:
    _, rows = query(statement(schema, runs))
    return [(str(r[0]), int(str(r[1] or 0))) for r in rows]


def detail(found: list[tuple[str, int]], runs: int = RUNS) -> str:
    if not found:
        return f"No warn-severity check warned in each of the last {runs} builds."
    names = ", ".join(f"{name} ({failures} row(s) at most)" for name, failures in found)
    return (
        f"Warned in each of the last {runs} builds: {names}. A warning that persists is either a "
        'real problem to fix or a check to retune (docs/runbook.md, "Chronic warnings").'
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--engine", choices=("duckdb", "databricks"), required=True)
    parser.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    parser.add_argument("--schema", default="ops")
    parser.add_argument("--catalog", default="fantasyscout")
    parser.add_argument("--runs", type=int, default=RUNS)
    args = parser.parse_args(argv)
    env = os.environ
    if args.engine == "duckdb":
        query: Query = lambda sql: query_duckdb(args.duckdb, sql)  # noqa: E731
    else:
        query = lambda sql: query_databricks(  # noqa: E731
            sql,
            origin=env["DATABRICKS_ORIGIN"],
            token=env["DATABRICKS_TOKEN"],
            warehouse_id=env["DATABRICKS_WAREHOUSE_ID"],
            catalog=args.catalog,
        )
    found = chronic(query, args.schema, args.runs)
    for name, failures in found:
        print(
            f"::warning::chronic warning: {name} warned in each of the last {args.runs} builds "
            f"({failures} row(s) at most)"
        )
    text = detail(found, args.runs)
    print(text)
    Path("chronic.log").write_text(text + "\n", encoding="utf-8")
    out = env.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as handle:
            handle.write(f"checks={','.join(name for name, _ in found)}\n")
            handle.write(f"detail={text}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
