"""No workflow interpolates an expression into a shell script (#431).

GitHub substitutes ``${{ }}`` into a ``run:`` script before the shell sees it, so a value that
reaches it (a dispatch input, a matrix entry built from one, a step output) is executed as code.
Every value a script needs goes through the step's ``env:`` and is read as a quoted variable.
"""

from __future__ import annotations

import re
from pathlib import Path

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
