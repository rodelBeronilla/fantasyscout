"""The Pipeline page says what the workflows do (#471).

The page describes the ingest schedule, the order of the ESPN and reports jobs and the deploy's
Lighthouse step in prose. Each claim here is read back from the workflow it describes, so a change
to the workflow fails until the page follows.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
PAGE = (ROOT / "web" / "src" / "pages" / "pipeline" / "index.astro").read_text(encoding="utf-8")
DIAGRAMS = (ROOT / "web" / "src" / "lib" / "pipeline-diagrams.ts").read_text(encoding="utf-8")


def _workflow(name: str) -> dict[Any, Any]:
    """The workflow file, parsed; YAML reads the bare ``on:`` key as True."""
    data: dict[Any, Any] = yaml.safe_load(
        (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
    )
    return data


def test_the_page_names_the_ingest_schedule() -> None:
    triggers = _workflow("ingest.yml")[True]
    times = []
    for entry in triggers["schedule"]:
        minute, hour = entry["cron"].split()[:2]
        times.append(f"{int(hour):02d}:{int(minute):02d}")
    assert len(times) == 4
    for t in times:
        assert f"{t} UTC" in PAGE or f"{t} and" in PAGE, t
        assert t in DIAGRAMS, t
    assert "09:15" not in PAGE + DIAGRAMS
    assert "23:00" not in PAGE + DIAGRAMS


def test_espn_runs_one_league_at_a_time_and_the_reports_follow_it() -> None:
    jobs = _workflow("ingest.yml")["jobs"]
    assert jobs["espn"]["strategy"]["max-parallel"] == 1
    assert "espn" in jobs["reports"]["needs"]
    assert "one league at a time, and the reports jobs wait for the ESPN jobs" in PAGE
    assert "in parallel" not in PAGE.split('id="runs"')[1].split("</p>")[1]


def test_the_page_names_the_pages_lighthouse_measures() -> None:
    step = next(
        s
        for s in _workflow("deploy-web.yml")["jobs"]["deploy"]["steps"]
        if str(s.get("name", "")).startswith("Lighthouse")
    )
    assert "for page in home streamers schema" in step["run"]
    assert "Lighthouse three times on the home, Streamers and Schema pages" in PAGE
