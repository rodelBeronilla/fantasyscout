from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import duckdb
import pytest

from ops.results import (
    Gate,
    _sql_literal,
    decide,
    insert_statements,
    load_rows,
    main,
    write_duckdb,
)

RUN_AT = datetime(2026, 10, 27, 9, 30)


def write_artifacts(
    target: Path, results: list[dict[str, object]], nodes: dict[str, dict[str, object]]
) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "run_results.json").write_text(
        json.dumps({"metadata": {"invocation_id": "abcdef123456-7890"}, "results": results}),
        encoding="utf-8",
    )
    (target / "manifest.json").write_text(json.dumps({"nodes": nodes}), encoding="utf-8")


def artifacts(tmp_path: Path, *, closure_status: str = "pass", chaos: bool = False) -> Path:
    nodes: dict[str, dict[str, object]] = {
        "model.fantasyscout.fct_player_game": {"resource_type": "model", "name": "fct_player_game"},
        "test.fantasyscout.assert_box_closure.1": {
            "resource_type": "test",
            "name": "assert_box_closure",
            "config": {"severity": "error"},
            "depends_on": {
                "nodes": ["model.fantasyscout.fct_player_game", "model.fantasyscout.fct_team_game"]
            },
        },
        "test.fantasyscout.warn_minutes_closure.2": {
            "resource_type": "test",
            "name": "warn_minutes_closure",
            "config": {"severity": "warn"},
            "depends_on": {"nodes": ["model.fantasyscout.fct_player_game"]},
        },
        "test.fantasyscout.chaos_deliberate_failure.3": {
            "resource_type": "test",
            "name": "chaos_deliberate_failure",
            "config": {"severity": "error"},
            "depends_on": {"nodes": []},
        },
    }
    results: list[dict[str, object]] = [
        {
            "unique_id": "model.fantasyscout.fct_player_game",
            "status": "success",
            "execution_time": 1.5,
        },
        {
            "unique_id": "test.fantasyscout.assert_box_closure.1",
            "status": closure_status,
            "failures": 24 if closure_status == "fail" else 0,
        },
        {
            "unique_id": "test.fantasyscout.warn_minutes_closure.2",
            "status": "warn",
            "failures": 3,
            "message": "Got 3 results",
        },
    ]
    if chaos:
        results.append(
            {
                "unique_id": "test.fantasyscout.chaos_deliberate_failure.3",
                "status": "fail",
                "failures": 1,
            }
        )
    write_artifacts(tmp_path / "target", results, nodes)
    return tmp_path / "target"


def test_rows_carry_severity_and_tested_models(tmp_path: Path) -> None:
    rows = load_rows(artifacts(tmp_path), engine="duckdb", git_sha="abc", run_at=RUN_AT)
    by_name = {r.check_name: r for r in rows}
    assert by_name["assert_box_closure"].severity == "error"
    assert by_name["assert_box_closure"].model == "fct_player_game, fct_team_game"
    assert by_name["warn_minutes_closure"].severity == "warn"
    assert by_name["warn_minutes_closure"].failures == 3
    assert by_name["fct_player_game"].resource_type == "model"
    assert all(r.run_id == "abcdef123456" for r in rows)


def test_gate_passes_with_warns_only(tmp_path: Path) -> None:
    gate = decide(load_rows(artifacts(tmp_path), engine="duckdb", git_sha="abc", run_at=RUN_AT))
    assert gate == Gate(
        True, 0, 1, 0, "all error-severity checks passed; 1 warn-severity check(s) flagged"
    )


def test_gate_blocks_on_error_severity_failure(tmp_path: Path) -> None:
    gate = decide(
        load_rows(
            artifacts(tmp_path, closure_status="fail"),
            engine="duckdb",
            git_sha="abc",
            run_at=RUN_AT,
        )
    )
    assert not gate.passed and gate.error_failures == 1
    assert gate.reason == "blocked by: assert_box_closure"


def test_gate_blocks_on_chaos_and_names_it(tmp_path: Path) -> None:
    gate = decide(
        load_rows(artifacts(tmp_path, chaos=True), engine="duckdb", git_sha="abc", run_at=RUN_AT)
    )
    assert not gate.passed and "chaos_deliberate_failure" in gate.reason


def test_sql_literals_are_safe() -> None:
    assert _sql_literal(None) == "null"
    assert _sql_literal(True) == "true"
    assert _sql_literal(3) == "3"
    assert _sql_literal("it's 'quoted'") == "'it''s ''quoted'''"
    assert _sql_literal(RUN_AT) == "timestamp '2026-10-27 09:30:00'"


def test_duckdb_writer_creates_tables_and_rows(tmp_path: Path) -> None:
    rows = load_rows(
        artifacts(tmp_path, closure_status="fail"), engine="duckdb", git_sha="abc", run_at=RUN_AT
    )
    gate = decide(rows)
    statements = insert_statements(
        "ops", rows, gate, run_id="abcdef123456", run_at=RUN_AT, engine="duckdb", git_sha="abc"
    )
    db = tmp_path / "t.duckdb"
    write_duckdb(db, statements)
    write_duckdb(db, statements)  # idempotent DDL, append rows
    con = duckdb.connect(str(db), read_only=True)
    assert con.sql("select count(*) from ops.test_results").fetchall()[0][0] == 6
    assert con.sql("select passed, error_failures from ops.publish_gate").fetchall() == [
        (False, 1),
        (False, 1),
    ]
    con.close()


def test_main_exit_codes(tmp_path: Path) -> None:
    target = artifacts(tmp_path)
    assert main(["--engine", "duckdb", "--target-dir", str(target), "--dry-run"]) == 0
    target = artifacts(tmp_path / "blocked", chaos=True)
    assert main(["--engine", "duckdb", "--target-dir", str(target), "--dry-run"]) == 2


def test_databricks_writer_refuses_an_empty_warehouse_and_reports_the_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import httpx

    import ops.results as results_mod

    with pytest.raises(RuntimeError, match="warehouse_id is empty"):
        results_mod.write_databricks(
            ["select 1"], origin="https://x", token="t", warehouse_id="", catalog="c"
        )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"message": "Invalid warehouse id"})

    original = httpx.Client
    monkeypatch.setattr(
        results_mod.httpx,
        "Client",
        lambda **kw: original(transport=httpx.MockTransport(handler), **kw),
    )
    with pytest.raises(RuntimeError, match=r"HTTP 400 .*Invalid warehouse id"):
        results_mod.write_databricks(
            ["select 1"], origin="https://x", token="t", warehouse_id="w", catalog="c"
        )


def test_failing_rows_are_sampled_on_duckdb(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    import duckdb

    from ops.results import main

    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute("create table games as select 'wnba' as league, '1022600001' as game_id")
    con.close()
    nodes: dict[str, dict[str, object]] = {
        "test.fantasyscout.assert_completeness.9": {
            "resource_type": "test",
            "name": "assert_completeness",
            "config": {"severity": "error"},
            "depends_on": {"nodes": []},
        },
    }
    results: list[dict[str, object]] = [
        {
            "unique_id": "test.fantasyscout.assert_completeness.9",
            "status": "fail",
            "failures": 1,
            "execution_time": 0.1,
            "message": "Got 1 result",
            "compiled_code": "select league, game_id from games",
        }
    ]
    write_artifacts(tmp_path / "target", results, nodes)
    code = main(
        [
            "--engine",
            "duckdb",
            "--duckdb",
            str(db),
            "--target-dir",
            str(tmp_path / "target"),
            "--dry-run",
        ]
    )
    out = capsys.readouterr().out
    assert code == 2
    assert "sample of assert_completeness (1 of 1 rows):" in out
    assert "league | game_id" in out
    assert "wnba | 1022600001" in out
