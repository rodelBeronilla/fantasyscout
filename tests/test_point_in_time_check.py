"""The point-in-time check names every leak, every over-cut and every missing table (#752)."""

from __future__ import annotations

from datetime import date

import duckdb

from ops.point_in_time_check import DATED, MORNING, MORNING_INSTANTS, cut_reference, dropped, leaks

AS_OF = date(2026, 1, 10)


def _db(games: list[str], waiver_rows: int = 0) -> duckdb.DuckDBPyConnection:
    """Every dated table the check reads, empty, with the given player games."""
    con = duckdb.connect(":memory:")
    con.execute("create schema gold")
    con.execute("create schema silver")
    columns: dict[str, list[str]] = {}
    for table, col in DATED:
        columns.setdefault(table, []).append(col)
    for table, col in MORNING:
        columns.setdefault(table, []).append(col)
    instants = dict(MORNING_INSTANTS)
    for table, cols in columns.items():
        typed = [f"{c} date" for c in cols]
        if table in instants:
            typed.append(f"{instants[table]} timestamptz")
        con.execute(f"create table {table} ({', '.join(typed)})")
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


def _birth_dates(rows: int) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute("create schema silver")
    con.execute("create table silver.player_birth_dates (player_id varchar, birth_date date)")
    for i in range(rows):
        con.execute("insert into silver.player_birth_dates values (?, date '2000-01-01')", [str(i)])
    return con


def test_reference_data_cut_by_the_build_is_named() -> None:
    full = _birth_dates(2)
    assert cut_reference(_birth_dates(2), full) == []
    assert cut_reference(_birth_dates(0), full) == [
        "silver.player_birth_dates: 0 rows, the full build has 2, but it is never cut"
    ]
    assert cut_reference(duckdb.connect(":memory:"), full) == [
        "silver.player_birth_dates: missing from the build"
    ]


def test_the_injury_feeds_may_hold_the_days_morning_and_nothing_later() -> None:
    con = _db(["2026-01-09"])
    # the morning's listing and a report published at 6 am Eastern (11:00 UTC): known that morning
    con.execute("insert into silver.injuries values (date '2026-01-10')")
    con.execute(
        "insert into silver.official_injury_report values"
        " (date '2026-01-10', timestamptz '2026-01-10 11:00:00+00:00')"
    )
    assert leaks(con, AS_OF) == []
    # a listing of the next day, and a report published after the cut (5 pm Eastern)
    con.execute("insert into silver.injuries values (date '2026-01-11')")
    con.execute(
        "insert into silver.official_injury_report values"
        " (date '2026-01-10', timestamptz '2026-01-10 22:00:00+00:00')"
    )
    found = leaks(con, AS_OF)
    assert "silver.injuries: 1 rows with report_date after 2026-01-10" in found
    assert any(
        f.startswith("silver.official_injury_report: 1 rows with published_at") for f in found
    )


def test_only_the_two_injury_feeds_are_cut_at_the_morning() -> None:
    """No input other than ESPN's listing and the official reports changed its cut (#1140): the
    morning macros appear in their three silver models only, which no longer cut by date."""
    from pathlib import Path

    models = Path(__file__).resolve().parent.parent / "dbt" / "models"
    morning = {
        p.stem for p in models.rglob("*.sql") if "by_morning(" in p.read_text(encoding="utf-8")
    }
    assert morning == {"injuries", "injury_status_history", "official_injury_report"}
    for name in morning:
        sql = next(models.rglob(f"{name}.sql")).read_text(encoding="utf-8")
        assert "known_before(" not in sql
    assert not {t for t, _ in DATED} & {t for t, _ in MORNING}
