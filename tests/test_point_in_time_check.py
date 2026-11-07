"""The point-in-time check names every leak, every over-cut and every missing table (#752)."""

from __future__ import annotations

from datetime import date

import duckdb

from ops.point_in_time_check import DATED, dropped, leaks

AS_OF = date(2026, 1, 10)


def _db(games: list[str], waiver_rows: int = 0) -> duckdb.DuckDBPyConnection:
    """Every dated table the check reads, empty, with the given player games."""
    con = duckdb.connect(":memory:")
    con.execute("create schema gold")
    con.execute("create schema silver")
    columns: dict[str, list[str]] = {}
    for table, col in DATED:
        columns.setdefault(table, []).append(col)
    for table, cols in columns.items():
        con.execute(f"create table {table} ({', '.join(f'{c} date' for c in cols)})")
    for d in games:
        con.execute("insert into gold.fct_player_game values (cast(? as date))", [d])
    con.execute("create table gold.fct_waiver_trend (sleeper_player_id varchar)")
    for _ in range(waiver_rows):
        con.execute("insert into gold.fct_waiver_trend values ('x')")
    return con


def test_a_clean_build_has_no_leak() -> None:
    assert leaks(_db(["2026-01-09"]), AS_OF) == []


def test_a_game_on_the_day_and_a_newest_only_source_are_named() -> None:
    found = leaks(_db(["2026-01-09", "2026-01-10"], waiver_rows=1), AS_OF)
    assert any(f.startswith("gold.fct_player_game: 1 rows") for f in found)
    assert any(f.startswith("gold.fct_waiver_trend") for f in found)


def test_a_dated_table_or_column_the_build_lacks_fails() -> None:
    con = _db([])
    con.execute("drop table silver.standings")
    con.execute("create table silver.standings (team_id integer)")
    assert "silver.standings.observed_date: missing from the build" in leaks(con, AS_OF)


def test_a_game_cut_too_far_back_is_named() -> None:
    full = _db(["2026-01-08", "2026-01-09"])
    # lost the 8th: cut by the day it landed, not the day it was played
    cut = _db(["2026-01-09"])
    assert dropped(cut, full, AS_OF) == [
        "gold.fct_player_game: 1 rows before 2026-01-10, the full build has 2"
    ]
    assert dropped(full, full, AS_OF) == []
