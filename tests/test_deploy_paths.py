"""A push that changes the dbt project deploys the site (#475).

The dbt docs at /docs/ are CI's artifact of the same commit and ship with the site, so a
change under dbt/ alone has to deploy or /docs/ keeps describing the project before it.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def test_a_dbt_change_counts_as_touching_the_site() -> None:
    path = ROOT / ".github" / "workflows" / "deploy-web.yml"
    workflow = yaml.safe_load(path.read_text("utf-8"))
    step = next(s for s in workflow["jobs"]["deploy"]["steps"] if s.get("id") == "touched")
    diff = next(line for line in step["run"].splitlines() if "git diff --name-only" in line)
    paths = diff.split(" -- ", 1)[1].split("|", 1)[0].split()
    assert {"web", "worker", "dbt", ".github/workflows/deploy-web.yml"} <= set(paths)
