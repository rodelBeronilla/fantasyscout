"""Chronic warnings: a warn check that warned in each of the last five builds (#421)."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import duckdb

from ops import chronic


def _results(path: Path, builds: list[dict[str, str]]) -> None:
    """One build per entry: check name -> status, all warn severity, one build a day."""
    con = duckdb.connect(str(path))
    con.execute("create schema ops")
    con.execute(
        "create table ops.test_results (run_id varchar, run_at timestamp, check_name varchar,"
        " severity varchar, status varchar, failures bigint)"
    )
    start = datetime(2026, 10, 25, 9, 30)
    for i, statuses in enumerate(builds):
        for name, status in statuses.items():
            con.execute(
                "insert into ops.test_results values (?, ?, ?, ?, ?, ?)",
                [
                    f"run{i}",
                    start + timedelta(days=i),
                    name,
                    "warn",
                    status,
                    3 if status == "warn" else 0,
                ],
            )
    con.close()


def _query(path: Path) -> chronic.Query:
    return lambda sql: chronic.query_duckdb(path, sql)


def test_a_check_that_warned_in_each_of_the_last_five_builds_is_chronic(tmp_path: Path) -> None:
    db = tmp_path / "results.duckdb"
    builds = [
        {"warn_volume": "pass", "warn_stale": "pass", "warn_conflicts": "warn"},
        {"warn_volume": "warn", "warn_stale": "warn", "warn_conflicts": "warn"},
        {"warn_volume": "warn", "warn_stale": "warn", "warn_conflicts": "warn"},
        {"warn_volume": "warn", "warn_stale": "warn", "warn_conflicts": "warn"},
        {"warn_volume": "warn", "warn_stale": "warn", "warn_conflicts": "warn"},
        {"warn_volume": "warn", "warn_stale": "pass", "warn_conflicts": "warn"},
    ]
    _results(db, builds)
    # the last five: volume and conflicts warned in all five (volume passed only in the sixth
    # newest, which no longer counts); stale passed in the newest
    assert chronic.chronic(_query(db)) == [("warn_conflicts", 3), ("warn_volume", 3)]
    text = chronic.detail(chronic.chronic(_query(db)))
    assert "warn_conflicts" in text and "warn_volume" in text and "warn_stale" not in text


def test_fewer_than_five_builds_or_a_clean_one_is_not_chronic(tmp_path: Path) -> None:
    db = tmp_path / "few.duckdb"
    _results(db, [{"warn_volume": "warn"}] * 4)
    assert chronic.chronic(_query(db)) == []
    clean = tmp_path / "clean.duckdb"
    _results(
        clean,
        [{"warn_volume": "warn"}] * 4 + [{"warn_volume": "pass"}] + [{"warn_volume": "warn"}] * 4,
    )
    assert chronic.chronic(_query(clean)) == []
    assert chronic.detail([]).startswith("No warn-severity check")
