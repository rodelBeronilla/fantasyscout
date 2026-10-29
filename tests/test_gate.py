"""The hand-run export checks the latest publish gate first (#96 item 2)."""

from __future__ import annotations

from pathlib import Path

import duckdb

from ops import gate

COLUMNS = ["run_id", "run_at", "passed", "error_failures", "model_errors", "reason"]
GATE_DDL = (
    "create table ops.publish_gate (run_id varchar, run_at timestamp, engine varchar,"
    " git_sha varchar, passed boolean, error_failures bigint, warn_failures bigint,"
    " model_errors bigint, reason varchar)"
)


def test_decide_passes_only_on_a_passing_latest_gate() -> None:
    ok, line = gate.decide(COLUMNS, [["r2", "2026-10-29 14:00", True, 0, 0, ""]])
    assert ok and "passed" in line
    ok, line = gate.decide(COLUMNS, [["r3", "2026-10-29 15:00", "false", 2, 0, "2 error checks"]])
    assert not ok and "blocked" in line and "2 error checks" in line
    ok, line = gate.decide(COLUMNS, [])
    assert not ok and "no publish gate" in line


def _insert(db: Path, rows: str) -> None:
    con = duckdb.connect(str(db))
    con.execute(f"insert into ops.publish_gate values {rows}")
    con.close()


def test_main_reads_the_latest_row(tmp_path: Path) -> None:
    db = tmp_path / "lake.duckdb"
    con = duckdb.connect(str(db))
    con.execute("create schema ops")
    con.execute(GATE_DDL)
    con.close()
    _insert(
        db,
        "('old', '2026-10-28 10:00', 'duckdb', 'a', true, 0, 0, 0, ''),"
        " ('new', '2026-10-29 10:00', 'duckdb', 'b', false, 1, 0, 0, 'completeness')",
    )
    assert gate.main(["--engine", "duckdb", "--duckdb", str(db)]) == 2
    _insert(db, "('newer', '2026-10-30 10:00', 'duckdb', 'c', true, 0, 0, 0, '')")
    assert gate.main(["--engine", "duckdb", "--duckdb", str(db)]) == 0
