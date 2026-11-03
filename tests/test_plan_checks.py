"""Planning the quality checks against the sample catches SQL mistakes (#395)."""

from __future__ import annotations

import duckdb

from ops.plan_checks import plan, quality_checks


def test_only_compiled_quality_tests_are_planned() -> None:
    manifest: dict[str, object] = {
        "nodes": {
            "test.a": {
                "resource_type": "test",
                "name": "warn_a",
                "tags": ["quality"],
                "compiled_code": "select 1",
            },
            "test.b": {
                "resource_type": "test",
                "name": "not_null_x",
                "tags": [],
                "compiled_code": "select 1",
            },
            "test.c": {"resource_type": "test", "name": "warn_c", "tags": ["quality"]},
            "model.d": {
                "resource_type": "model",
                "name": "d",
                "tags": ["quality"],
                "compiled_code": "select 1",
            },
        }
    }
    assert quality_checks(manifest) == [("warn_a", "select 1")]


def test_a_typo_or_a_missing_column_fails_and_is_named() -> None:
    con = duckdb.connect()
    con.execute("create table board as select 1 as player_id")
    failed = plan(
        con,
        [
            ("warn_good", "select player_id from board where player_id > 1"),
            ("warn_typo", "selec player_id from board"),
            ("warn_column", "select no_such_column from board"),
        ],
    )
    assert [f.split(":")[0] for f in failed] == ["warn_typo", "warn_column"]
