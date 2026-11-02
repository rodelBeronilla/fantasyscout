"""The play-by-play chain's pre-hook says something Delta accepts (#480).

`replace_changed_games` (dbt/macros/incremental.sql) runs first on the lakehouse: DuckDB, which CI
builds the sample on, accepts statements Delta rejects, so a change that is wrong only for Delta
passes CI and fails the nightly build. That happened with a multi-column IN in the hook's DELETE
(DELTA_UNSUPPORTED_MULTI_COL_IN_PREDICATE, fixed by PR 375). This test renders the macro in each
of its three states with plain Jinja, the dbt context stubbed, and checks the statements against
the rules Delta enforces.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

jinja2 = pytest.importorskip("jinja2")

MACROS = Path(__file__).resolve().parent.parent / "dbt" / "macros" / "incremental.sql"
SOURCES = ["silver.events_src", "silver.lineups_src"]
# (league, game_id) in (...): Delta's DELETE does not take a multi-column IN.
MULTI_COLUMN_IN = re.compile(r"\(\s*\w+\s*,\s*\w+[^()]*\)\s+in\s*\(", re.IGNORECASE)


def _render(*, incremental: bool, watermark: bool) -> str:
    source = MACROS.read_text(encoding="utf-8")
    # has_watermark() returns a value through dbt's `return`, which plain Jinja does not have; the
    # test supplies it instead, so the template's own definition is taken out.
    source = re.sub(r"\{% macro has_watermark\(\) -%\}.*?\{%- endmacro %\}", "", source, flags=re.S)
    env = jinja2.Environment(undefined=jinja2.StrictUndefined)
    env.globals.update(
        is_incremental=lambda: incremental,
        has_watermark=lambda: watermark,
        run_query=lambda _sql: SimpleNamespace(
            columns=[SimpleNamespace(values=lambda: ["2026-11-01"])]
        ),
        this="silver.events",
    )
    module = env.from_string(source).module
    return str(module.replace_changed_games(SOURCES))


def test_an_incremental_run_deletes_the_changed_games_by_one_key() -> None:
    sql = _render(incremental=True, watermark=True)
    assert sql.lower().count("delete from silver.events") == 1
    assert "concat_ws(':', league, game_id) in (" in sql
    assert "cast('2026-11-01' as date)" in sql
    for source in SOURCES:
        assert f"from {source}" in sql
    assert not MULTI_COLUMN_IN.search(sql), sql


def test_a_table_without_the_watermark_is_emptied_once() -> None:
    sql = _render(incremental=True, watermark=False)
    assert "delete from silver.events where true" in sql
    assert not MULTI_COLUMN_IN.search(sql)


def test_a_full_build_runs_a_harmless_statement() -> None:
    assert "select 1 as nothing_to_replace" in _render(incremental=False, watermark=False)


def test_the_pattern_catches_the_statement_delta_rejected() -> None:
    """What PR 375 replaced: the check would have failed on it."""
    assert MULTI_COLUMN_IN.search(
        "delete from t where (league, game_id) in (select league, game_id from x)"
    )
