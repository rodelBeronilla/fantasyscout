"""The parameter registry is well formed, matches dbt, and the web reads it current (#765)."""

from __future__ import annotations

from pathlib import Path

import yaml

from ops import parameters


def test_the_registry_is_well_formed() -> None:
    assert parameters.problems(parameters.load()) == []


def test_every_dbt_entry_matches_its_var() -> None:
    assert parameters.dbt_mismatches(parameters.load()) == []


def test_the_generated_module_is_current() -> None:
    assert parameters.OUT.read_text(encoding="utf-8") == parameters.render(parameters.load())


def test_a_bad_entry_and_a_drifted_var_are_named(tmp_path: Path) -> None:
    entry = {
        "id": "x",
        "value": 1,
        "kind": "guess",
        "status": "assumed",
        "what": "w",
        "evidence": "e",
    }
    found = parameters.problems([entry, dict(entry)])
    assert any("missing ['validation']" in f for f in found)
    assert any("kind 'guess'" in f for f in found)
    assert any("registered twice" in f for f in found)
    project = tmp_path / "dbt_project.yml"
    project.write_text(yaml.safe_dump({"vars": {"fantasy_team_change": 0.3}}), encoding="utf-8")
    drift = [{"id": "projection.team_change", "value": 0.25, "dbt": "fantasy_team_change"}]
    assert parameters.dbt_mismatches(drift, project) == [
        "projection.team_change: registry 0.25, dbt fantasy_team_change 0.3"
    ]
