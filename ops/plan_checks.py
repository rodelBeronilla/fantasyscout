"""Plan every data-quality check against the sample: a SQL mistake fails CI, not the gate.

    (cd dbt && uv run dbt compile --target duckdb --select tag:quality)
    uv run python -m ops.plan_checks --duckdb dbt/fantasyscout.duckdb

The quality checks (tag:quality) do not run on the sample, which is a shape fixture rather than a
coherent season, so before this a typo or a missing column in a new check first surfaced as a
blocked nightly gate (#395). ``dbt compile`` renders the templates but does not parse the SQL;
this asks DuckDB to EXPLAIN each compiled check against the built sample, which parses it and
binds every table and column without running it. Exit status 1 names the checks that fail.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import duckdb


def quality_checks(manifest: dict[str, object], tag: str = "quality") -> list[tuple[str, str]]:
    """(name, compiled SQL) of every compiled test carrying the tag."""
    nodes = manifest.get("nodes")
    out: list[tuple[str, str]] = []
    for node in (nodes if isinstance(nodes, dict) else {}).values():
        if not isinstance(node, dict) or node.get("resource_type") != "test":
            continue
        if tag in (node.get("tags") or []) and node.get("compiled_code"):
            out.append((str(node.get("name")), str(node["compiled_code"])))
    return sorted(out)


def plan(con: duckdb.DuckDBPyConnection, checks: list[tuple[str, str]]) -> list[str]:
    """The checks DuckDB cannot plan, each with the first line of its error."""
    failed: list[str] = []
    for name, sql in checks:
        try:
            con.execute("EXPLAIN " + sql)
        except duckdb.Error as e:
            failed.append(f"{name}: {str(e).splitlines()[0]}")
    return failed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    parser.add_argument("--manifest", type=Path, default=Path("dbt/target/manifest.json"))
    args = parser.parse_args(argv)
    checks = quality_checks(json.loads(args.manifest.read_text(encoding="utf-8")))
    if not checks:
        print("::error::no compiled quality checks; run dbt compile --select tag:quality first")
        return 1
    with duckdb.connect(str(args.duckdb), read_only=True) as con:
        failed = plan(con, checks)
    for line in failed:
        print(f"::error::{line}")
    print(f"{len(checks)} quality checks planned against the sample; {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
