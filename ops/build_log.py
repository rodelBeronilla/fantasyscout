"""One row per Build lakehouse run, in ``ops.build_log``, and a step summary.

    uv run python -m ops.build_log --engine databricks --summary

Runs as the workflow's Report step. The row ties together what the other tables keep apart: the
GitHub run (and the ingest run that triggered it), the dbt invocation and its gate, the export's
build id, the selector of a light build, each step's outcome and duration (from the Actions API),
how long the job queued for a runner, and the rows per table the build published (from its
manifest). ``--summary`` writes the same facts as Markdown to ``$GITHUB_STEP_SUMMARY``, so a run's
page says what the build did without opening a log. Data Health shows the recent rows.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from ops.results import (
    Gate,
    _sql_literal,
    decide,
    load_rows,
    merge_rows,
    write_databricks,
    write_duckdb,
)

JOB_NAME = "dbt build on Databricks"
# The steps the row times, by the name the workflow gives them, in the order they run.
STEPS = {
    "dbt build": "build",
    "Record results and decide the publish gate": "gate",
    "Export gold to R2 (staged)": "export",
    "Execute the analysis notebooks against the staged build and add them to it": "notebooks",
    "Refresh the Tableau extract and add it to the staged build": "extract",
    "Promote the build (latest.json points at it)": "promote",
}

BUILD_LOG_DDL = """
create table if not exists {schema}.build_log (
    run_id string, run_url string, run_at timestamp, finished_at timestamp, event string,
    trigger_run_id string, trigger_run_url string, git_sha string, invocation_id string,
    build_id string, selected string, light boolean, outcome string, gate_passed boolean,
    gate_reason string, error_checks bigint, warn_checks bigint, queue_seconds double,
    build_seconds double, total_seconds double, steps string, rows string,
    schedule_delay_seconds double
)
"""

# Columns added after the table first existed; each is added if the table lacks it, so the row
# can be inserted by name on both engines (#385).
BUILD_LOG_ADDED_COLUMNS = (("schedule_delay_seconds", "double"),)

# The ingest's daily crons, read from the workflow so a moved cron moves the measure with it;
# the constant is the fallback for a checkout without the file.
INGEST_WORKFLOW = Path(".github/workflows/ingest.yml")
INGEST_CRONS_FALLBACK: tuple[tuple[int, int], ...] = ((9, 27), (22, 41))


def ingest_crons(path: Path = INGEST_WORKFLOW) -> tuple[tuple[int, int], ...]:
    """The (hour, minute) of each daily cron in the ingest workflow."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return INGEST_CRONS_FALLBACK
    found = tuple(
        (int(h), int(m)) for m, h in re.findall(r'cron:\s*"(\d+)\s+(\d+)\s+\*\s+\*\s+\*"', text)
    )
    return found or INGEST_CRONS_FALLBACK


def schedule_delay(created_at: datetime | None, crons: tuple[tuple[int, int], ...]) -> float | None:
    """Seconds between the most recent daily cron slot and when the scheduled run was created.

    GitHub starts scheduled runs late on busy hours (three to seven hours in the first week of
    November 2026), which moves the evening injury-report ingest past tip-off; the measure makes
    that visible on Data Health and in ops.build_log (#385).
    """
    if created_at is None or not crons:
        return None
    moment = created_at.astimezone(UTC)
    slots: list[datetime] = []
    for day_back in (0, 1):
        base = (moment - timedelta(days=day_back)).replace(second=0, microsecond=0)
        slots.extend(base.replace(hour=h, minute=m) for h, m in crons)
    earlier = [s for s in slots if s <= moment]
    if not earlier:
        return None
    return round((moment - max(earlier)).total_seconds(), 1)


@dataclass
class BuildRecord:
    run_id: str
    run_url: str
    run_at: datetime | None
    finished_at: datetime
    event: str
    trigger_run_id: str | None
    trigger_run_url: str | None
    git_sha: str
    invocation_id: str | None
    build_id: str | None
    selected: str | None
    light: bool
    outcome: str
    gate_passed: bool | None
    gate_reason: str | None
    error_checks: int | None
    warn_checks: int | None
    queue_seconds: float | None
    build_seconds: float | None
    total_seconds: float | None
    steps: dict[str, dict[str, object]] = field(default_factory=dict)
    rows: dict[str, int] = field(default_factory=dict)
    # How late the scheduled ingest that triggered this build fired, against its cron; None for
    # a dispatched or unknown trigger.
    schedule_delay_seconds: float | None = None


def _ts(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _seconds(start: datetime | None, end: datetime | None) -> float | None:
    if start is None or end is None:
        return None
    return round((end - start).total_seconds(), 1)


def job_timings(
    run: Mapping[str, Any] | None, jobs: list[Mapping[str, Any]] | None, job_name: str = JOB_NAME
) -> tuple[datetime | None, float | None, dict[str, dict[str, object]]]:
    """The job's start, its queue time, and each named step's outcome and duration."""
    job = next((j for j in jobs or [] if j.get("name") == job_name), None)
    if job is None:
        return None, None, {}
    started = _ts(job.get("started_at"))
    created = _ts(run.get("created_at")) if run else None
    steps: dict[str, dict[str, object]] = {}
    for step in job.get("steps", []):
        short = STEPS.get(str(step.get("name", "")))
        if short is None:
            continue
        steps[short] = {
            "outcome": step.get("conclusion") or step.get("status"),
            "seconds": _seconds(_ts(step.get("started_at")), _ts(step.get("completed_at"))),
        }
    return started, _seconds(created, started), steps


def gate_of(target_dirs: list[Path], selected: str | None) -> tuple[Gate | None, str | None]:
    """The gate the run's dbt artifacts decide, and the dbt invocation id."""
    dirs = [d for d in target_dirs if (d / "run_results.json").exists()]
    if not dirs:
        return None, None
    now = datetime.now(UTC).replace(tzinfo=None)
    rows = merge_rows(*(load_rows(d, engine="", git_sha="", run_at=now) for d in dirs))
    invocation = rows[0].invocation_id if rows else None
    return decide(rows, selected=selected), invocation


def collect(
    env: Mapping[str, str],
    *,
    api: Callable[[str], Mapping[str, Any] | None],
    fetch_json: Callable[[str], Mapping[str, Any] | None],
    target_dirs: list[Path],
    now: datetime | None = None,
) -> BuildRecord:
    """Everything the row holds, from the environment, the Actions API and the build manifest."""
    now = now or datetime.now(UTC)
    repo = env.get("GITHUB_REPOSITORY", "")
    run_id = env.get("GITHUB_RUN_ID", "local")
    server = env.get("GITHUB_SERVER_URL", "https://github.com")
    run = api(f"/repos/{repo}/actions/runs/{run_id}") if repo and run_id != "local" else None
    jobs_body = api(f"/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100") if run else None
    jobs = list(jobs_body.get("jobs", [])) if isinstance(jobs_body, Mapping) else None
    started, queue, steps = job_timings(run, jobs)
    selected = env.get("SELECTED", "").strip() or None
    gate, invocation = gate_of(target_dirs, selected)
    build_id = env.get("BUILD_ID", "").strip() or None
    rows: dict[str, int] = {}
    site = env.get("SITE", "").rstrip("/")
    if build_id and site:
        manifest = fetch_json(f"{site}/data/builds/{build_id}/manifest.json")
        tables = manifest.get("tables") if isinstance(manifest, Mapping) else None
        if isinstance(tables, Mapping):
            rows = {
                str(name): int(entry.get("rows", 0))
                for name, entry in tables.items()
                if isinstance(entry, Mapping)
            }
    trigger = env.get("TRIGGER_RUN_ID", "").strip() or None
    trigger_run = api(f"/repos/{repo}/actions/runs/{trigger}") if repo and trigger else None
    delay = None
    if isinstance(trigger_run, Mapping) and trigger_run.get("event") == "schedule":
        delay = schedule_delay(_ts(trigger_run.get("created_at")), ingest_crons())
    build_step = steps.get("build", {})
    build_seconds = build_step.get("seconds") if isinstance(build_step, dict) else None
    return BuildRecord(
        run_id=run_id,
        run_url=f"{server}/{repo}/actions/runs/{run_id}" if repo else "",
        run_at=started,
        finished_at=now,
        event=env.get("GITHUB_EVENT_NAME", ""),
        trigger_run_id=trigger,
        trigger_run_url=env.get("TRIGGER_RUN_URL", "").strip() or None,
        git_sha=env.get("GITHUB_SHA", "")[:12],
        invocation_id=invocation,
        build_id=build_id,
        selected=selected,
        light=env.get("LIGHT", "").lower() == "true",
        outcome=env.get("OUTCOME", "unknown"),
        gate_passed=gate.passed if gate else None,
        gate_reason=gate.reason if gate else None,
        error_checks=gate.error_failures if gate else None,
        warn_checks=gate.warn_failures if gate else None,
        queue_seconds=queue,
        build_seconds=build_seconds if isinstance(build_seconds, int | float) else None,
        total_seconds=_seconds(started, now),
        steps=steps,
        rows=rows,
        schedule_delay_seconds=delay,
    )


def statements(schema: str, record: BuildRecord) -> list[str]:
    values = dict(asdict(record))
    values["run_at"] = record.run_at.replace(tzinfo=None) if record.run_at else None
    values["finished_at"] = record.finished_at.replace(tzinfo=None)
    values["steps"] = json.dumps(record.steps, sort_keys=True)
    values["rows"] = json.dumps(record.rows, sort_keys=True)
    columns = list(asdict(record))
    literal = ", ".join(_sql_literal(values[k]) for k in columns)
    return [
        BUILD_LOG_DDL.format(schema=schema),
        *(
            f"alter table {schema}.build_log add column if not exists {name} {kind}"
            for name, kind in BUILD_LOG_ADDED_COLUMNS
        ),
        f"insert into {schema}.build_log ({', '.join(columns)}) values ({literal})",
    ]


def _minutes(seconds: object) -> str:
    return f"{float(seconds) / 60:.1f} min" if isinstance(seconds, int | float) else "-"


def summary_markdown(record: BuildRecord) -> str:
    """The run's page: what the build did, in one table and a few lines."""
    gate = (
        "no gate recorded"
        if record.gate_passed is None
        else ("passed" if record.gate_passed else "**blocked**")
    )
    kind = "light build" if record.light else "full build"
    if record.selected:
        kind += f" (`{record.selected}`)"
    lines = [
        f"## Build lakehouse: {record.outcome}",
        "",
        f"- Gate: {gate}" + (f" — {record.gate_reason}" if record.gate_reason else ""),
        f"- Build: `{record.build_id}`" if record.build_id else "- Build: not published",
        f"- {kind}, triggered by `{record.event}`"
        + (
            f" ([run {record.trigger_run_id}]({record.trigger_run_url}))"
            if record.trigger_run_url
            else ""
        ),
        f"- Queued {_minutes(record.queue_seconds)}, dbt {_minutes(record.build_seconds)}, "
        f"total {_minutes(record.total_seconds)}"
        + (
            f"; the scheduled ingest fired {_minutes(record.schedule_delay_seconds)} after its cron"
            if record.schedule_delay_seconds is not None
            else ""
        ),
        "",
    ]
    if record.steps:
        lines += ["| Step | Outcome | Duration |", "| --- | --- | --- |"]
        lines += [
            f"| {name} | {info.get('outcome', '-')} | {_minutes(info.get('seconds'))} |"
            for name, info in record.steps.items()
        ]
        lines.append("")
    if record.rows:
        shown = sorted(record.rows.items(), key=lambda kv: -kv[1])[:12]
        lines += ["| Table | Rows |", "| --- | ---: |"]
        lines += [f"| {name} | {rows:,} |" for name, rows in shown]
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--engine", choices=("duckdb", "databricks"), required=True)
    parser.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    parser.add_argument("--target-dir", type=Path, action="append")
    parser.add_argument("--schema", default="ops")
    parser.add_argument("--catalog", default="fantasyscout")
    parser.add_argument("--summary", action="store_true", help="append to $GITHUB_STEP_SUMMARY")
    args = parser.parse_args(argv)
    env = os.environ

    token = env.get("GH_TOKEN", "")
    api_base = env.get("GITHUB_API_URL", "https://api.github.com")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}

    def api(path: str) -> Mapping[str, Any] | None:
        if not token:
            return None
        try:
            response = httpx.get(api_base + path, headers=headers, timeout=30)
        except httpx.HTTPError:
            return None
        body = response.json() if response.status_code == 200 else None
        return body if isinstance(body, Mapping) else None

    def fetch_json(url: str) -> Mapping[str, Any] | None:
        try:
            response = httpx.get(url, timeout=30, headers={"cache-control": "no-cache"})
        except httpx.HTTPError:
            return None
        body = response.json() if response.status_code == 200 else None
        return body if isinstance(body, Mapping) else None

    dirs = args.target_dir or [Path("dbt/target"), Path("dbt/target/quality")]
    record = collect(env, api=api, fetch_json=fetch_json, target_dirs=dirs)
    sql = statements(args.schema, record)
    if args.engine == "duckdb":
        write_duckdb(args.duckdb, sql)
    else:
        write_databricks(
            sql,
            origin=env["DATABRICKS_ORIGIN"],
            token=env["DATABRICKS_TOKEN"],
            warehouse_id=env["DATABRICKS_WAREHOUSE_ID"],
            catalog=args.catalog,
        )
    print(f"recorded build run {record.run_id} to {args.schema}.build_log")
    if args.summary:
        text = summary_markdown(record)
        path = env.get("GITHUB_STEP_SUMMARY")
        if path:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(text + "\n")
        else:
            print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
