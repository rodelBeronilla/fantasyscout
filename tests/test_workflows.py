"""No workflow interpolates an expression into a shell script (#431).

GitHub substitutes ``${{ }}`` into a ``run:`` script before the shell sees it, so a value that
reaches it (a dispatch input, a matrix entry built from one, a step output) is executed as code.
Every value a script needs goes through the step's ``env:`` and is read as a quoted variable.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
EXPR = re.compile(r"\$\{\{")


def _steps(document: dict[str, object]) -> list[dict[str, object]]:
    steps: list[dict[str, object]] = []
    jobs = document.get("jobs")
    if isinstance(jobs, dict):
        for job in jobs.values():
            if isinstance(job, dict):
                steps += [s for s in job.get("steps") or [] if isinstance(s, dict)]
    runs = document.get("runs")
    if isinstance(runs, dict):
        steps += [s for s in runs.get("steps") or [] if isinstance(s, dict)]
    return steps


def test_no_run_script_interpolates_an_expression() -> None:
    files = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
    files += sorted((ROOT / ".github" / "actions").glob("*/action.yml"))
    assert files
    offenders = []
    for path in files:
        for step in _steps(yaml.safe_load(path.read_text(encoding="utf-8"))):
            script = step.get("run")
            if isinstance(script, str) and EXPR.search(script):
                offenders.append(
                    f"{path.relative_to(ROOT).as_posix()}: {step.get('name', '(unnamed step)')}"
                )
    assert not offenders, "move these into the step's env: " + "; ".join(offenders)


SCHEDULE_CHECK = re.compile(r"github\.event\.schedule\s*==\s*'([^']+)'")


def test_every_schedule_comparison_names_a_declared_cron() -> None:
    """A step that branches on which schedule fired names a cron the workflow has (#577).

    #506 moved the evening ingest from 23:00 to 22:41 and left the check for "the evening run"
    comparing against the old string, so the evening run took the morning's path.
    """
    checked = 0
    for path in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        document = yaml.safe_load(text)
        # PyYAML reads the bare key `on` as the boolean True.
        triggers = document.get("on", document.get(True)) or {}
        crons = (
            {s["cron"] for s in (triggers.get("schedule") or [])}
            if isinstance(triggers, dict)
            else set()
        )
        for compared in SCHEDULE_CHECK.findall(text):
            checked += 1
            assert compared in crons, (
                f"{path.name} compares github.event.schedule to {compared!r}, "
                f"not one of {sorted(crons)}"
            )
    assert checked, "no workflow branches on its schedule; drop this test or the check moved"


def test_the_secret_scan_catches_the_key_kinds_the_project_holds() -> None:
    """The CI scan's pattern matches a PKCS#8 key and a service account's JSON key (#435)."""
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    pattern = re.search(r"pattern='([^']+)'", ci)
    assert pattern
    scan = re.compile(pattern.group(1))
    begin = "-----BEGIN " + "PRIVATE KEY-----"  # split so this file does not match the scan itself
    for fake in (
        begin,
        '"private_key": "' + begin,
        "-----BEGIN RSA " + "PRIVATE KEY-----",
        "AKIA" + "A" * 16,
    ):
        assert scan.search(fake), fake
    assert not scan.search("a PRIVATE KEY is mentioned in prose")


@pytest.mark.parametrize(
    ("workflow", "job", "folder"),
    [("claims.yml", "claims", "claims"), ("player-notes.yml", "notes", "player-notes")],
)
def test_the_news_workflows_upload_no_source_text(workflow: str, job: str, folder: str) -> None:
    """The claims' and the player notes' inputs hold source text and stay on the home runner
    (#861, #879).

    A workflow artifact on this public repository can be downloaded by any GitHub account, so
    these workflows upload nothing, run every job on the home runner and remove their inputs
    from the runner's disk whatever the outcome.
    """
    document = yaml.safe_load(
        (ROOT / ".github" / "workflows" / workflow).read_text(encoding="utf-8")
    )
    uses = [str(s.get("uses", "")) for s in _steps(document)]
    assert not [u for u in uses if "upload-artifact" in u or "download-artifact" in u]
    for name, j in document["jobs"].items():
        assert "self-hosted" in str(j["runs-on"]), f"{name} runs off the home runner"
    steps = document["jobs"][job]["steps"]
    cleanup = [s for s in steps if f'rm -rf "$RUNNER_TEMP/{folder}"' in str(s.get("run", ""))]
    assert cleanup and cleanup[0].get("if") == "always()" and cleanup[0] is steps[-1]


def test_the_player_notes_run_again_after_each_build() -> None:
    """After each published build, the evening report runs' among them, a changed run (#879)."""
    document = yaml.safe_load(
        (ROOT / ".github" / "workflows" / "player-notes.yml").read_text(encoding="utf-8")
    )
    build = yaml.safe_load((ROOT / ".github" / "workflows" / "build.yml").read_text("utf-8"))
    on = document[True]
    assert on["workflow_run"]["workflows"] == [build["name"]]
    job = document["jobs"]["notes"]
    assert "github.event.workflow_run.conclusion == 'success'" in job["if"]
    assert "github.event_name == 'workflow_run' && 'changed'" in job["env"]["MODE"]


def test_no_workflow_passes_the_owner_id_as_a_plain_variable() -> None:
    deploy = (ROOT / ".github" / "workflows" / "deploy-web.yml").read_text(encoding="utf-8")
    assert "vars.OWNER_YAHOO_GUID" not in deploy
