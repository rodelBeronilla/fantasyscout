"""Open or update a data-incident issue when a job fails; close it when the next run passes.

Runs on GitHub-hosted and self-hosted runners alike (no gh CLI needed): plain REST with the
job's GITHUB_TOKEN. Inputs come from the environment: TITLE, OUTCOME, GH_TOKEN, GITHUB_*, and
DETAIL (optional: which steps ran and which failed, put at the top of the issue or comment).
Reads land.log from the working directory when present.

The issue is routed by its title: the area label and the runbook section follow the kind of
failure (an ingest, a backfill, a build, an export, a stale site), and the issue is assigned to
the repository owner unless INCIDENT_ASSIGNEE says otherwise (empty to assign nobody). AREA and
PRIORITY override the defaults.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path

import httpx

DEFAULT_PRIORITY = "P1-high"

# (title prefix, area label, runbook sections) in the order they are tried.
ROUTES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Ingest", "area:ingest", ("Rerun a day", "Replay failed fetches")),
    ("Backfill", "area:ingest", ("Backfill", "Replay failed fetches")),
    ("Build", "area:lakehouse", ("Quality checks, results table and the publish gate",)),
    ("Export", "area:ops", ("Export and rollback",)),
    ("Publish", "area:ops", ("Publish SLA and the watchdog",)),
    ("Notebook", "area:docs", ("Build the lakehouse by hand",)),
)
FALLBACK = ("area:ops", ("Rerun a day",))


def route(title: str) -> tuple[str, tuple[str, ...]]:
    """The area label and runbook sections for an incident with this title."""
    for prefix, area, sections in ROUTES:
        if title.lower().startswith(prefix.lower()):
            return area, sections
    return FALLBACK


def labels(title: str, area: str | None = None, priority: str | None = None) -> list[str]:
    return ["data-incident", priority or DEFAULT_PRIORITY, area or route(title)[0]]


def runbook_hint(title: str) -> str:
    sections = ", ".join(f'"{s}"' for s in route(title)[1])
    return f"See docs/runbook.md ({sections})."


def assignees(env: Mapping[str, str]) -> list[str]:
    """Who the issue is assigned to: INCIDENT_ASSIGNEE, else the repository owner, else nobody."""
    if "INCIDENT_ASSIGNEE" in env:
        who = env["INCIDENT_ASSIGNEE"].strip()
        return [who] if who else []
    owner = env.get("GITHUB_REPOSITORY_OWNER", "").strip()
    return [owner] if owner else []


ERROR_MARKS = ("ERROR", "Error", "Traceback", "failed ", "FAIL ", "blocked by")


def first_errors(lines: list[str], limit: int = 10) -> list[str]:
    """The first lines that name an error, so the cause sits above the log's tail (#406).

    The tail alone showed warn samples and progress lines while the cause (a model's Database
    Error, a fetch's HTTP 429) had scrolled off; the lines matching the error marks, in order,
    are what an operator reads first.
    """
    out: list[str] = []
    for line in lines:
        text = line.strip()
        if any(mark in text for mark in ERROR_MARKS) and text not in out:
            out.append(text[:300])
            if len(out) >= limit:
                break
    return out


def main() -> int:
    title = os.environ["TITLE"]
    outcome = os.environ.get("OUTCOME", "failure")
    detail = os.environ.get("DETAIL", "").strip()
    lead = f"{detail}\n\n" if detail else ""
    repo = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ.get("GITHUB_RUN_ID", "?")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_url = f"{server}/{repo}/actions/runs/{run_id}"
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")

    log_path = Path("land.log")
    lines = (
        log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if log_path.exists()
        else []
    )
    tail = "\n".join(lines[-80:]) if lines else "(no log)"
    firsts = first_errors(lines)
    if firsts:
        lead += "First errors:\n```\n" + "\n".join(firsts) + "\n```\n\n"

    client = httpx.Client(
        base_url=f"{api}/repos/{repo}",
        headers={
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )
    open_issues = client.get(
        "/issues", params={"labels": "data-incident", "state": "open", "per_page": 100}
    )
    open_issues.raise_for_status()
    existing = next((i["number"] for i in open_issues.json() if i["title"] == title), None)

    if outcome == "success":
        if existing is not None:
            body = f"Recovered: [run {run_id}]({run_url}) passed.\n\n{lead}```\n{tail}\n```"
            client.post(f"/issues/{existing}/comments", json={"body": body}).raise_for_status()
            client.patch(f"/issues/{existing}", json={"state": "closed"}).raise_for_status()
            print(f"closed incident #{existing}")
        return 0

    body = (
        f"Outcome: **{outcome}**. [Run {run_id}]({run_url})\n\n{lead}```\n{tail}\n```\n\n"
        + runbook_hint(title)
    )
    if existing is not None:
        client.post(f"/issues/{existing}/comments", json={"body": body}).raise_for_status()
        print(f"updated incident #{existing}")
    else:
        payload = {
            "title": title,
            "body": body,
            "labels": labels(title, os.environ.get("AREA"), os.environ.get("PRIORITY")),
            "assignees": assignees(os.environ),
        }
        created = client.post("/issues", json=payload)
        created.raise_for_status()
        print(f"opened incident #{created.json()['number']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
