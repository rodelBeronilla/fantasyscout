from __future__ import annotations

from pathlib import Path

import duckdb
import httpx
import pytest

from ops import summary


def test_duckdb_table_is_printed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    con.execute("create schema ops")
    con.execute(
        "create table ops.reconciliation_summary as select 'wnba' as league, '2026' as season, "
        "637 as player_games, 637 as matched, 0 as unmatched, 1.0 as match_rate, "
        "637 as exact, 0 as minor, 0 as conflict, 0.0 as conflict_rate"
    )
    con.close()
    assert summary.main(["--engine", "duckdb", "--duckdb", str(db)]) == 0
    out = capsys.readouterr().out
    assert "ops.reconciliation_summary (1 rows):" in out
    assert "league | season | player_games" in out
    assert "wnba | 2026 | 637 | 637 | 0 | 1.0000 | 637 | 0 | 0 | 0.0000" in out


def test_databricks_rows_are_rendered(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "statement_id": "s1",
                "status": {"state": "SUCCEEDED"},
                "manifest": {"schema": {"columns": [{"name": "league"}, {"name": "match_rate"}]}},
                "result": {"data_array": [["nba", "0.99123"]]},
            },
        )

    original = httpx.Client
    monkeypatch.setattr(
        summary,
        "_databricks_client",
        lambda o, t: original(base_url=o, transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setenv("DATABRICKS_ORIGIN", "https://x")
    monkeypatch.setenv("DATABRICKS_TOKEN", "t")
    monkeypatch.setenv("DATABRICKS_WAREHOUSE_ID", "w")
    assert summary.main(["--engine", "databricks"]) == 0
    out = capsys.readouterr().out
    assert "nba | 0.9912" in out


def test_a_missing_table_never_fails_the_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "empty.duckdb"
    duckdb.connect(str(db)).close()
    assert summary.main(["--engine", "duckdb", "--duckdb", str(db)]) == 0
    assert "unavailable" in capsys.readouterr().out
