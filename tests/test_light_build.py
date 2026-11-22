"""A light build must not read a model the change adds, and runs no unit tests (#956)."""

from __future__ import annotations

from pathlib import Path

from ops.light_build import EXCLUDE_RESOURCE_TYPE, SELECT, problems, relations

BUILD = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "build.yml"


def _node(uid: str, kind: str, *parents: str) -> dict[str, object]:
    return {"unique_id": uid, "resource_type": kind, "depends_on": {"nodes": list(parents)}}


def test_build_yml_runs_the_selection_the_check_reads() -> None:
    text = BUILD.read_text(encoding="utf-8")
    assert f'echo "PLAN_SELECT={SELECT}"' in text
    light = '[ "${PLAN_LIGHT:-}" = "true" ]'
    assert f"{light} && args+=(--exclude-resource-type {EXCLUDE_RESOURCE_TYPE})" in text


def test_relations_are_models_and_seeds_by_file() -> None:
    paths = [
        "dbt/models/silver/player_birth_dates.sql",
        "dbt/models/silver/_silver.yml",
        "dbt/seeds/venues.csv",
        "dbt/tests/assert_x.sql",
        "dbt\\models\\gold\\mart_board.sql",
    ]
    assert relations(paths) == {
        "model.player_birth_dates",
        "seed.venues",
        "model.mart_board",
    }


def test_a_selected_model_reading_a_new_model_it_does_not_build_is_caught() -> None:
    nodes = [
        _node("model.fs.int_known_roster", "model", "model.fs.rosters", "model.fs.birth_dates"),
        _node("model.fs.mart_board", "model", "model.fs.int_known_roster"),
    ]
    assert problems(nodes, {"model.birth_dates"}) == [
        ("model.fs.int_known_roster", "model.fs.birth_dates")
    ]


def test_a_new_model_the_light_build_builds_itself_is_fine() -> None:
    nodes = [
        _node("model.fs.new_report", "model", "model.fs.injuries"),
        _node("model.fs.mart_board", "model", "model.fs.new_report"),
    ]
    assert problems(nodes, {"model.new_report"}) == []


def test_an_existing_parent_outside_the_selection_is_fine() -> None:
    nodes = [_node("model.fs.int_known_roster", "model", "model.fs.rosters")]
    assert problems(nodes, set()) == []


def test_tests_and_seeds_count_and_listed_nodes_do_not() -> None:
    nodes = [
        _node("test.fs.relationships_x", "test", "model.fs.x", "model.fs.new_dim"),
        _node("model.fs.x", "model", "seed.fs.new_seed"),
        _node("exposure.fs.notebook", "exposure", "model.fs.new_dim"),
    ]
    assert problems(nodes, {"model.new_dim", "seed.new_seed"}) == [
        ("model.fs.x", "seed.fs.new_seed"),
        ("test.fs.relationships_x", "model.fs.new_dim"),
    ]
