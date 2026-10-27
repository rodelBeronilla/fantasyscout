"""Open or update a data-incident issue when an ingest job fails; close it when the next run passes.

Runs on GitHub-hosted and self-hosted runners alike (no gh CLI needed): plain REST with the
job's GITHUB_TOKEN. Inputs come from the environment: TITLE, OUTCOME, GH_TOKEN, GITHUB_*.
Reads land.log from the working directory when present.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx

LABELS = ["data-incident", "P1-high", "area:ingest"]


def main() -> int:
    title = os.environ["TITLE"]
    outcome = os.environ.get("OUTCOME", "failure")
    repo = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ.get("GITHUB_RUN_ID", "?")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_url = f"{server}/{repo}/actions/runs/{run_id}"
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")

    log_path = Path("land.log")
    tail = (
        "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-25:])
        if log_path.exists()
        else "(no log)"
    )

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
            body = f"Recovered: [run {run_id}]({run_url}) passed.\n\n```\n{tail}\n```"
            client.post(f"/issues/{existing}/comments", json={"body": body}).raise_for_status()
            client.patch(f"/issues/{existing}", json={"state": "closed"}).raise_for_status()
            print(f"closed incident #{existing}")
        return 0

    body = (
        f"Outcome: **{outcome}**. [Run {run_id}]({run_url})\n\n```\n{tail}\n```\n\n"
        'See docs/runbook.md ("Rerun a day").'
    )
    if existing is not None:
        client.post(f"/issues/{existing}/comments", json={"body": body}).raise_for_status()
        print(f"updated incident #{existing}")
    else:
        created = client.post("/issues", json={"title": title, "body": body, "labels": LABELS})
        created.raise_for_status()
        print(f"opened incident #{created.json()['number']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
