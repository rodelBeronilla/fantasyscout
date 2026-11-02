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
from typing import NamedTuple

import httpx

DEFAULT_PRIORITY = "P1-high"
# A step that fails after the promotion leaves the new data live: the site is right, a page of
# analysis or the dashboard's source is late (#422).
AFTER_PROMOTE = "P2-medium"


# The route of an incident by its title's prefix, tried in order; the build's titles name their
# first failed step, so the specific ones come before "Build".
class Route(NamedTuple):
    prefix: str
    area: str
    sections: tuple[str, ...]
    priority: str = DEFAULT_PRIORITY


ROUTES: tuple[Route, ...] = (
    Route("Ingest", "area:ingest", ("Rerun a day", "Replay failed fetches")),
    Route("Backfill", "area:ingest", ("Backfill", "Replay failed fetches")),
    Route(
        "Build failure: export", "area:ops", ("Export and rollback", "Warehouse refuses statements")
    ),
    Route("Build failure: promote", "area:ops", ("Export and rollback",)),
    Route(
        "Build failure: notebooks",
        "area:docs",
        ("Incident issues", "Build the lakehouse by hand"),
        AFTER_PROMOTE,
    ),
    Route(
        "Build failure: Tableau extract",
        "area:ops",
        ("Incident issues", "Build the lakehouse by hand"),
        AFTER_PROMOTE,
    ),
    Route("Build failure: sheet push", "area:ops", ("Incident issues",), AFTER_PROMOTE),
    Route("Build", "area:lakehouse", ("Quality checks, results table and the publish gate",)),
    Route("Export", "area:ops", ("Export and rollback", "Warehouse refuses statements")),
    Route("Warehouse", "area:lakehouse", ("Warehouse refuses statements",)),
    Route("Publish", "area:ops", ("Publish SLA and the watchdog",)),
    Route("Notebook", "area:docs", ("Build the lakehouse by hand",)),
)
FALLBACK = ("area:ops", ("Rerun a day",))


def _match(title: str) -> Route | None:
    return next((r for r in ROUTES if title.lower().startswith(r.prefix.lower())), None)


def route(title: str) -> tuple[str, tuple[str, ...]]:
    """The area label and runbook sections for an incident with this title."""
    found = _match(title)
    return (found.area, found.sections) if found else FALLBACK


def priority_of(title: str) -> str:
    """The priority an incident with this title opens with: P1 unless its route says otherwise."""
    found = _match(title)
    return found.priority if found else DEFAULT_PRIORITY


def labels(title: str, area: str | None = None, priority: str | None = None) -> list[str]:
    return ["data-incident", priority or priority_of(title), area or route(title)[0]]


def to_close(issues: list[dict[str, object]], title: str, prefix: str = "") -> list[int]:
    """The open incidents a passing run closes: its own title, and every title with CLOSE_PREFIX.

    A build's incident names the step that failed (#422), so the next passing build closes any
    "Build failure: ..." it finds, not only one exact title.
    """
    return [
        int(str(i["number"]))
        for i in issues
        if i["title"] == title or (prefix and str(i["title"]).startswith(prefix))
    ]


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

    log_path = Path(os.environ.get("LOG_PATH", "land.log"))
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
        for number in to_close(open_issues.json(), title, os.environ.get("CLOSE_PREFIX", "")):
            body = f"Recovered: [run {run_id}]({run_url}) passed.\n\n{lead}```\n{tail}\n```"
            client.post(f"/issues/{number}/comments", json={"body": body}).raise_for_status()
            client.patch(f"/issues/{number}", json={"state": "closed"}).raise_for_status()
            print(f"closed incident #{number}")
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
