"""Record dbt results in ``ops.test_results`` and decide the publish gate.

    uv run python -m ops.results --engine duckdb --duckdb dbt/fantasyscout.duckdb
    uv run python -m ops.results --engine databricks   # origin, token, warehouse from env

Reads ``dbt/target/run_results.json`` and ``manifest.json`` after a build. Every test and
model outcome becomes a row (check, model, severity, status, failing rows, run id), so
quality history is queryable rather than buried in logs. The gate passes only when no
error-severity test failed and no model errored; warn-severity failures publish but are
reported. A blocked gate exits with status 2 so the workflow can raise an incident.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx

Engine = Literal["duckdb", "databricks"]

TEST_RESULTS_DDL = """
create table if not exists {schema}.test_results (
    run_id string, run_at timestamp, engine string, git_sha string, invocation_id string,
    node_id string, check_name string, resource_type string, model string, severity string,
    status string, failures bigint, execution_time double, message string
)
"""
PUBLISH_GATE_DDL = """
create table if not exists {schema}.publish_gate (
    run_id string, run_at timestamp, engine string, git_sha string, passed boolean,
    error_failures bigint, warn_failures bigint, model_errors bigint, reason string
)
"""


@dataclass(frozen=True)
class ResultRow:
    run_id: str
    run_at: datetime
    engine: str
    git_sha: str
    invocation_id: str
    node_id: str
    check_name: str
    resource_type: str
    model: str
    severity: str
    status: str
    failures: int
    execution_time: float
    message: str

    @property
    def is_test(self) -> bool:
        return self.resource_type == "test"


@dataclass(frozen=True)
class Gate:
    passed: bool
    error_failures: int
    warn_failures: int
    model_errors: int
    reason: str


def load_rows(target_dir: Path, *, engine: str, git_sha: str, run_at: datetime) -> list[ResultRow]:
    run_results = json.loads((target_dir / "run_results.json").read_text(encoding="utf-8"))
    manifest = json.loads((target_dir / "manifest.json").read_text(encoding="utf-8"))
    nodes = manifest["nodes"]
    invocation_id = run_results["metadata"]["invocation_id"]
    run_id = invocation_id[:12]
    rows: list[ResultRow] = []
    for result in run_results["results"]:
        node = nodes.get(result["unique_id"], {})
        resource_type = node.get("resource_type", result["unique_id"].split(".")[0])
        if resource_type == "test":
            severity = str(node.get("config", {}).get("severity", "error")).lower()
            depends_on = node.get("depends_on", {}).get("nodes", [])
            tested = [n.split(".")[-1] for n in depends_on if n.startswith("model.")]
            model = ", ".join(tested) or "(none)"
        else:
            severity = "error"
            model = node.get("name", result["unique_id"])
        rows.append(
            ResultRow(
                run_id=run_id,
                run_at=run_at,
                engine=engine,
                git_sha=git_sha,
                invocation_id=invocation_id,
                node_id=result["unique_id"],
                check_name=node.get("name", result["unique_id"]),
                resource_type=resource_type,
                model=model,
                severity=severity,
                status=result["status"],
                failures=int(result.get("failures") or 0),
                execution_time=float(result.get("execution_time") or 0.0),
                message=(result.get("message") or "")[:1000],
            )
        )
    return rows


def decide(rows: list[ResultRow]) -> Gate:
    error_failures = sum(
        1 for r in rows if r.is_test and r.status == "fail" and r.severity == "error"
    )
    warn_failures = sum(
        1 for r in rows if r.is_test and r.status in ("warn", "fail") and r.severity == "warn"
    )
    model_errors = sum(1 for r in rows if not r.is_test and r.status == "error")
    test_errors = sum(1 for r in rows if r.is_test and r.status == "error")
    passed = error_failures == 0 and model_errors == 0 and test_errors == 0
    if passed:
        reason = f"all error-severity checks passed; {warn_failures} warn-severity check(s) flagged"
    else:
        blocking = [
            r.check_name
            for r in rows
            if (r.is_test and r.status in ("fail", "error") and r.severity == "error")
            or (not r.is_test and r.status == "error")
        ]
        reason = "blocked by: " + ", ".join(blocking[:10]) + (" ..." if len(blocking) > 10 else "")
    return Gate(passed, error_failures, warn_failures, model_errors + test_errors, reason)


def _sql_literal(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return repr(value)
    if isinstance(value, datetime):
        return f"timestamp '{value.strftime('%Y-%m-%d %H:%M:%S')}'"
    text = str(value).replace("\\", "\\\\").replace("'", "''")
    return f"'{text}'"


def insert_statements(
    schema: str,
    rows: list[ResultRow],
    gate: Gate,
    *,
    run_id: str,
    run_at: datetime,
    engine: str,
    git_sha: str,
) -> list[str]:
    statements = [TEST_RESULTS_DDL.format(schema=schema), PUBLISH_GATE_DDL.format(schema=schema)]
    if rows:
        values = ",\n".join(
            "(" + ", ".join(_sql_literal(v) for v in asdict(r).values()) + ")" for r in rows
        )
        statements.append(f"insert into {schema}.test_results values\n{values}")
    gate_fields = (
        run_id,
        run_at,
        engine,
        git_sha,
        gate.passed,
        gate.error_failures,
        gate.warn_failures,
        gate.model_errors,
        gate.reason,
    )
    gate_values = ", ".join(_sql_literal(v) for v in gate_fields)
    statements.append(f"insert into {schema}.publish_gate values ({gate_values})")
    return statements


def write_duckdb(path: Path, statements: list[str]) -> None:
    import duckdb  # local engine only

    con = duckdb.connect(str(path))
    try:
        con.execute("create schema if not exists ops")
        for statement in statements:
            con.execute(statement.replace(" string", " varchar"))
    finally:
        con.close()


def write_databricks(
    statements: list[str], *, origin: str, token: str, warehouse_id: str, catalog: str
) -> None:
    """Run each statement through the SQL Statement Execution API and wait for it."""
    client = httpx.Client(base_url=origin, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    for statement in statements:
        response = client.post(
            "/api/2.0/sql/statements",
            json={
                "warehouse_id": warehouse_id,
                "catalog": catalog,
                "statement": statement,
                "wait_timeout": "30s",
            },
        )
        response.raise_for_status()
        body = response.json()
        state = body["status"]["state"]
        statement_id = body["statement_id"]
        while state in ("PENDING", "RUNNING"):
            time.sleep(2)
            body = client.get(f"/api/2.0/sql/statements/{statement_id}").json()
            state = body["status"]["state"]
        if state != "SUCCEEDED":
            error = body.get("status", {}).get("error", {}).get("message", "")[:300]
            msg = f"statement failed ({state}): {error}"
            raise RuntimeError(msg)


def _git_sha() -> str:
    env_sha = os.environ.get("GITHUB_SHA")
    if env_sha:
        return env_sha
    proc = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return proc.stdout.strip() or "unknown"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Record dbt results and decide the publish gate.")
    parser.add_argument("--engine", choices=("duckdb", "databricks"), required=True)
    parser.add_argument("--target-dir", type=Path, default=Path("dbt/target"))
    parser.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    parser.add_argument("--schema", default="ops")
    parser.add_argument("--catalog", default="fantasyscout")
    parser.add_argument(
        "--dry-run", action="store_true", help="print the gate decision, write nothing"
    )
    args = parser.parse_args(argv)

    run_at = datetime.now(UTC).replace(tzinfo=None)
    git_sha = _git_sha()[:12]
    rows = load_rows(args.target_dir, engine=args.engine, git_sha=git_sha, run_at=run_at)
    gate = decide(rows)
    run_id = rows[0].run_id if rows else "no-results"
    verdict = "PASSED" if gate.passed else "BLOCKED"
    print(f"results: {len(rows)} rows; gate {verdict}: {gate.reason}")
    for r in rows:
        if r.is_test and r.status in ("fail", "warn", "error"):
            print(f"  {r.severity:5} {r.status:5} {r.check_name} ({r.model}) rows={r.failures}")
    if not args.dry_run:
        statements = insert_statements(
            args.schema,
            rows,
            gate,
            run_id=run_id,
            run_at=run_at,
            engine=args.engine,
            git_sha=git_sha,
        )
        if args.engine == "duckdb":
            write_duckdb(args.duckdb, statements)
        else:
            write_databricks(
                statements,
                origin=os.environ["DATABRICKS_ORIGIN"],
                token=os.environ["DATABRICKS_TOKEN"],
                warehouse_id=os.environ["DATABRICKS_WAREHOUSE_ID"],
                catalog=args.catalog,
            )
        print(f"recorded to {args.schema}.test_results and {args.schema}.publish_gate")
    return 0 if gate.passed else 2


if __name__ == "__main__":
    sys.exit(main())
