"""The committed web fixture is what the export produces (#245).

The Playwright tests read ``web/tests/fixtures/data`` as the site's data. If the export's layout
changes and the fixture is not refreshed, the pages are tested against files and keys the export
never produced. These tests hold the committed fixture to the export: the board and streamer
files carry exactly the layout's columns; every per-league file's keys are the columns its export
query returns (read from the query's schema, so the shape sample's row count does not matter);
and the build has the same JSON files as a fresh export. CI builds the dbt sample before pytest;
locally, build it first or the sample-backed tests skip.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import pytest

from export import build as build_mod
from export import fixture, layout
from export.encode import columns_of
from export.source import DuckDBSource

ROOT = Path(__file__).resolve().parent.parent
DBT_DB = ROOT / "dbt" / "fantasyscout.duckdb"
FIXTURE = fixture.FIXTURE_ROOT / "builds" / fixture.BUILD_ID
REFRESH = "run: uv run python -m export.fixture"


def _keys(data: object) -> set[str]:
    rows = data if isinstance(data, list) else [data]
    return set().union(*(row.keys() for row in rows if isinstance(row, dict)))


def _load(path: str) -> object:
    return json.loads((FIXTURE / Path(*path.split("/"))).read_text(encoding="utf-8"))


def test_fixture_pointer_names_the_pinned_build() -> None:
    latest = json.loads((fixture.FIXTURE_ROOT / "latest.json").read_text(encoding="utf-8"))
    assert latest["build_id"] == fixture.BUILD_ID
    assert latest["created_at"] == fixture.CREATED_AT
    manifest = json.loads((FIXTURE / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["git_sha"] == fixture.GIT_SHA
    health = _load("health.json")
    assert isinstance(health, dict) and health["build_id"] == fixture.BUILD_ID


def test_the_fixture_league_has_a_populated_board_and_its_player_files() -> None:
    board = _load(f"board/{fixture.LEAGUE}.json")
    assert isinstance(board, list) and len(board) > 50
    for row in board[:20]:
        assert (FIXTURE / "players" / fixture.LEAGUE / f"{row['player_id']}.json").is_file()


def test_board_and_streamer_files_carry_exactly_the_layout_columns() -> None:
    for league in layout.LEAGUES:
        board = _load(f"board/{league}.json")
        if board:
            assert _keys(board) == set(layout.BOARD_COLUMNS), (league, REFRESH)
        streamers = _load(f"streamers/{league}.json")
        if streamers:
            assert _keys(streamers) == set(layout.STREAMER_COLUMNS), (league, REFRESH)


def test_only_kept_files_are_committed() -> None:
    committed = set(fixture.committed_files())
    assert committed, "no fixture committed"
    stray = sorted(p for p in committed if not fixture.keeps(p))
    assert not stray, f"files the fixture does not keep: {stray[:10]} ({REFRESH})"


@pytest.fixture(scope="module")
def source() -> Iterator[DuckDBSource]:
    if not DBT_DB.exists():
        pytest.skip("dbt sample not built")
    src = DuckDBSource(DBT_DB)
    yield src
    src.close()


@pytest.fixture(scope="module")
def fresh(source: DuckDBSource) -> build_mod.Build:
    return build_mod.assemble(
        source,
        engine="duckdb",
        git_sha=fixture.GIT_SHA,
        build_id=fixture.BUILD_ID,
        created_at=fixture.CREATED_AT,
        skip_tables=frozenset({"fct_event"}),
        log=lambda _: None,
    )


def test_per_league_files_have_the_columns_their_export_query_returns(
    source: DuckDBSource,
) -> None:
    for name, sql in layout.PER_LEAGUE_JSON:
        expected = set(source.query(sql).schema.names)
        for league in layout.LEAGUES:
            rows = _load(f"{name}/{league}.json")
            if rows:
                assert _keys(rows) == expected, (f"{name}/{league}.json", REFRESH)


def test_the_column_wise_copies_are_the_row_files_column_by_column() -> None:
    """#535: the pages read these first; they must say exactly what the row files say."""
    for name in layout.COLUMNAR_JSON:
        for league in layout.LEAGUES:
            rows = _load(f"{name}/{league}.json")
            assert _load(f"{name}/{league}.columns.json") == columns_of(
                cast(list[dict[str, Any]], rows)
            ), (
                name,
                league,
                REFRESH,
            )


def test_fixture_has_the_json_files_a_fresh_export_produces(fresh: build_mod.Build) -> None:
    produced = {p for p in fresh.files if fixture.keeps(p) and not p.startswith("players/")}
    committed = {p for p in fixture.committed_files() if not p.startswith("players/")}
    # The ops tables exist only once the gate has run against the sample, which the Python job
    # does not do; a real build always has them, so the fixture may carry them when the sample
    # cannot.
    ops_json = {f"{spec.name}.json" for spec in layout.OPS if spec.json}
    ops_parquet = {f"{spec.name}.parquet" for spec in layout.OPS}
    # The notebooks and the Tableau extract add their files to a build after staging.
    side = {p for p in committed if p.startswith(("notebooks/", "tableau/"))}
    missing = produced - committed - ops_json - ops_parquet
    assert not missing, f"missing from fixture: {sorted(missing)[:10]} ({REFRESH})"
    stale = committed - produced - ops_json - ops_parquet - side
    assert not stale, f"stale in fixture: {sorted(stale)[:10]} ({REFRESH})"
    # Root tables with rows in the sample: the same keys (the fixture trims rows, never columns).
    drift = {}
    for path in sorted(produced & committed):
        if "/" in path or path == "health.json" or not path.endswith(".json"):
            continue
        fresh_rows = json.loads(fresh.files[path])
        if isinstance(fresh_rows, list) and fresh_rows:
            theirs, ours = _keys(fresh_rows), _keys(_load(path))
            if ours and theirs != ours:
                drift[path] = (sorted(theirs - ours), sorted(ours - theirs))
    assert not drift, f"keys differ (missing, stale) by file: {drift} ({REFRESH})"
    assert _keys(json.loads(fresh.files["health.json"])) == _keys(_load("health.json"))


def test_player_files_keep_their_nested_shape(fresh: build_mod.Build) -> None:
    produced_paths = sorted(p for p in fresh.files if p.startswith("players/"))
    assert produced_paths, "the sample export made no player files"
    produced = json.loads(fresh.files[produced_paths[0]])
    committed_path = sorted(p for p in fixture.committed_files() if p.startswith("players/"))[0]
    committed = _load(committed_path)
    assert isinstance(committed, dict)
    assert set(produced) == set(committed), (
        f"player file keys: missing {sorted(set(produced) - set(committed))}, "
        f"stale {sorted(set(committed) - set(produced))} ({REFRESH})"
    )
    # Sections the sample fills: the same keys inside them too.
    for section, value in produced.items():
        if isinstance(value, dict | list) and value and committed.get(section):
            assert _keys(value) == _keys(committed[section]), (section, REFRESH)
