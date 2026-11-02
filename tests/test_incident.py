"""Incidents are routed by their title: area label, runbook section, assignee (#251)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / ".github" / "scripts" / "incident.py"
spec = importlib.util.spec_from_file_location("incident", SCRIPT)
assert spec is not None and spec.loader is not None
incident = importlib.util.module_from_spec(spec)
spec.loader.exec_module(incident)


def test_the_title_decides_the_area_and_the_runbook_section() -> None:
    assert incident.route("Ingest failure: stats nba")[0] == "area:ingest"
    assert incident.route("Backfill failure: espn wnba 2024")[0] == "area:ingest"
    assert incident.route("Build failure: dbt on Databricks")[0] == "area:lakehouse"
    assert (
        incident.route("Publish stale: the live build is older than the SLA allows")[0]
        == "area:ops"
    )
    assert incident.route("Export failure")[0] == "area:ops"
    assert incident.route("Warehouse refuses statements: x")[0] == "area:lakehouse"
    assert "Warehouse refuses statements" in incident.runbook_hint(
        "Warehouse refuses statements: x"
    )
    assert "Warehouse refuses statements" in incident.runbook_hint("Export failure: build by hand")
    assert incident.route("Something else")[0] == "area:ops"
    assert "Replay failed fetches" in incident.runbook_hint("Ingest failure: espn nba")
    assert "publish gate" in incident.runbook_hint("Build failure: dbt on Databricks")
    assert "watchdog" in incident.runbook_hint("Publish stale: x")


def test_labels_take_overrides() -> None:
    assert incident.labels("Build failure") == ["data-incident", "P1-high", "area:lakehouse"]
    assert incident.labels("Build failure", "area:web", "P0-critical") == [
        "data-incident",
        "P0-critical",
        "area:web",
    ]


def test_the_owner_is_assigned_unless_told_otherwise() -> None:
    assert incident.assignees({"GITHUB_REPOSITORY_OWNER": "someone"}) == ["someone"]
    assert incident.assignees(
        {"GITHUB_REPOSITORY_OWNER": "someone", "INCIDENT_ASSIGNEE": "else"}
    ) == ["else"]
    assert incident.assignees({"GITHUB_REPOSITORY_OWNER": "someone", "INCIDENT_ASSIGNEE": ""}) == []
    assert incident.assignees({}) == []


def test_the_first_errors_are_pulled_from_anywhere_in_the_log() -> None:
    lines = [
        "progress stats nba: 25 requests",
        "  Database Error in model events (models/silver/events.sql)",
        "  [DELTA_UNSUPPORTED_MULTI_COL_IN_PREDICATE] Multi-column In predicates are not supported",
        *(f"  warn sample {i}" for i in range(100)),
        "results: 555 rows; gate BLOCKED: blocked by: events, shots",
        "  Database Error in model events (models/silver/events.sql)",
    ]
    firsts = incident.first_errors(lines)
    assert firsts[0].startswith("Database Error in model events")
    assert any("blocked by" in f for f in firsts)
    assert len([f for f in firsts if f.startswith("Database Error in model events")]) == 1, (
        "no duplicates"
    )
    assert incident.first_errors(["all fine", "landed 3"]) == []
    assert len(incident.first_errors([f"ERROR {i}" for i in range(30)])) == 10


def test_a_build_incident_is_routed_by_its_first_failed_step() -> None:
    """The title names the step; a step after the promotion is P2, the data is live (#422)."""
    assert incident.labels("Build failure: dbt build") == [
        "data-incident",
        "P1-high",
        "area:lakehouse",
    ]
    assert incident.labels("Build failure: publish gate") == [
        "data-incident",
        "P1-high",
        "area:lakehouse",
    ]
    assert incident.labels("Build failure: export") == ["data-incident", "P1-high", "area:ops"]
    assert incident.labels("Build failure: sheet push") == [
        "data-incident",
        "P2-medium",
        "area:ops",
    ]
    assert incident.labels("Build failure: Tableau extract") == [
        "data-incident",
        "P2-medium",
        "area:ops",
    ]
    assert incident.labels("Build failure: notebooks") == [
        "data-incident",
        "P2-medium",
        "area:docs",
    ]
    assert "publish gate" in incident.runbook_hint("Build failure: dbt build")
    assert "Export and rollback" in incident.runbook_hint("Build failure: promote")


def test_a_passing_build_closes_every_build_failure_and_nothing_else() -> None:
    issues = [
        {"number": 1, "title": "Build failure: dbt on Databricks"},
        {"number": 2, "title": "Build failure: sheet push"},
        {"number": 3, "title": "Ingest failure: espn nba"},
    ]
    assert incident.to_close(issues, "Build failure: dbt build", "Build failure") == [1, 2]
    assert incident.to_close(issues, "Ingest failure: espn nba") == [3]
