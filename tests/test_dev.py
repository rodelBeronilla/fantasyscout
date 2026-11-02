"""fs-dev runs what CI runs (#288)."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from ops import dev

ROOT = Path(__file__).resolve().parent.parent


def test_the_python_job_runs_fs_dev_and_nothing_else_of_its_own() -> None:
    ci = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8"))
    runs = [s["run"].strip() for s in ci["jobs"]["python"]["steps"] if "run" in s]
    assert runs[0] == "uv run fs-dev check", runs
    # the notebooks and the Tableau extract follow; no lint, type or test command of its own
    assert not any(re.search(r"\b(ruff|mypy|pytest|dbt build)\b", r) for r in runs[1:]), runs


def test_the_readme_and_contributing_quote_the_same_command() -> None:
    for name in ("README.md", "CONTRIBUTING.md"):
        text = (ROOT / name).read_text(encoding="utf-8")
        assert "uv run fs-dev check" in text, name


def test_the_documented_dbt_commands_match_the_dev_check_and_find_the_profile() -> None:
    """#468: the sample build in CONTRIBUTING excludes the data checks like fs-dev does, and the
    runbook's hand build sets the profile directory from inside dbt/."""
    contributing = (ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8")
    assert (
        "DBT_PROFILES_DIR=. uv run dbt build --target duckdb --exclude tag:quality" in contributing
    )
    runbook = (ROOT / "docs" / "runbook.md").read_text(encoding="utf-8")
    assert "cd dbt && DBT_PROFILES_DIR=. uv run dbt build --target databricks" in runbook
    assert "DBT_PROFILES_DIR=dbt" not in runbook
    dbt_step = next(s for s in dev.steps_for({"python"}) if s.name.startswith("dbt build"))
    assert dbt_step.cwd == "dbt" and "--exclude" in dbt_step.command and "tag:quality" in dbt_step.command


def test_the_default_steps_are_the_python_job_in_order() -> None:
    names = [s.name for s in dev.steps_for({"python"})]
    assert names == [
        "ruff check",
        "ruff format",
        "mypy",
        "the dbt sample's landing files",
        "dbt build on DuckDB (the sample; data checks excluded)",
        "pytest",
    ]
    assert dev.main(["check", "--list"]) == 0
    assert len(dev.steps_for({"python", "web", "worker"})) == len(dev.STEPS)
