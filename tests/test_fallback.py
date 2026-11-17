"""The DuckDB fallback road's ledgers and parity check (#989)."""

from __future__ import annotations

import datetime
import io
import json
from pathlib import Path, PurePosixPath

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from export.store import LocalStore
from ops import fallback


def _parquet(table: pa.Table) -> bytes:
    sink = io.BytesIO()
    pq.write_table(table, sink)
    return sink.getvalue()


def _publish(store: LocalStore, build_id: str, engine: str, tables: dict[str, pa.Table]) -> None:
    """A published build as the export lays it out: Parquet, a manifest, builds.json, latest."""
    manifest: dict[str, object] = {"build_id": build_id, "engine": engine, "tables": {}}
    for name, table in tables.items():
        path = f"{name.split('.', 1)[1]}.parquet"
        store.put(f"builds/{build_id}/{path}", _parquet(table))
        manifest["tables"][name] = {"rows": table.num_rows, "files": [path]}  # type: ignore[index]
    store.put(f"builds/{build_id}/manifest.json", json.dumps(manifest).encode())
    builds = json.loads(store.get("builds.json") or b"[]")
    builds.insert(0, {"build_id": build_id, "engine": engine})
    store.put("builds.json", json.dumps(builds).encode())
    store.put("latest.json", json.dumps({"build_id": build_id}).encode())


def _board(values: list[float], players: tuple[str, ...] = ("1", "2", "3")) -> pa.Table:
    return pa.table(
        {
            "league": ["nba"] * len(players),
            "player_id": list(players),
            "rank_total": list(range(1, len(players) + 1)),
            "value_total": values,
            "full_name": [f"P{p}" for p in players],
        }
    )


def _ledgers(day: datetime.date) -> dict[str, pa.Table]:
    return {
        "gold.fct_board_history": pa.table(
            {
                "board_history_sk": [f"{day}-1", f"{day}-2"],
                "snapshot_date": [day, day],
                "league": ["nba", "nba"],
                "player_id": ["1", "2"],
                "value_total": [3.0, 2.0],
            }
        ),
        "ops.publish_gate": pa.table(
            {"run_id": ["r1"], "engine": ["databricks"], "passed": [True], "reason": ["ok"]}
        ),
        "ops.build_log": pa.table(
            {
                "run_id": ["100"],
                "outcome": ["success"],
                "finished_at": [datetime.datetime(2026, 11, 10, 10, 0)],
            }
        ),
    }


def test_the_published_bucket_is_read_only(tmp_path: Path) -> None:
    store = fallback.ReadOnlyStore(LocalStore(tmp_path))
    with pytest.raises(PermissionError):
        store.put("latest.json", b"{}")
    with pytest.raises(PermissionError):
        store.delete("latest.json")
    assert store.get("latest.json") is None


def test_the_newest_build_of_an_engine(tmp_path: Path) -> None:
    store = LocalStore(tmp_path)
    _publish(store, "b1", "databricks", {"gold.mart_board": _board([1.0, 2.0, 3.0])})
    _publish(store, "b2", "duckdb", {"gold.mart_board": _board([1.0, 2.0, 3.0])})
    assert (fallback.newest_build(store) or {})["build_id"] == "b2"
    assert (fallback.newest_build(store, engine="databricks") or {})["build_id"] == "b1"
    assert fallback.newest_build(LocalStore(tmp_path / "empty")) is None


def test_the_seed_carries_the_ledgers_and_the_fallbacks_own_runs(tmp_path: Path) -> None:
    """The DuckDB file starts from the published history, plus the runs only the volume holds."""
    store = LocalStore(tmp_path / "published")
    _publish(store, "b1", "databricks", _ledgers(datetime.date(2026, 11, 10)))
    landing = tmp_path / "mirror"
    folder = landing / "landing" / "_ops" / "build_log"
    folder.mkdir(parents=True)
    (folder / "200-duckdb.json").write_text(
        json.dumps(
            {
                "run_id": "200",
                "engine": "duckdb",
                "outcome": "success",
                "finished_at": "2026-11-12 10:00:00",
            }
        )
    )
    # a row the published build already holds is not added twice
    (folder / "100-databricks.json").write_text(json.dumps({"run_id": "100"}))
    db = tmp_path / "fallback.duckdb"
    seeded = fallback.seed(store, db, landing, log=lambda _: None)
    assert seeded == {
        "gold.fct_board_history": 2,
        "ops.publish_gate": 1,
        "ops.build_log": 1,
        "ops.build_log (volume)": 1,
    }
    con = duckdb.connect(str(db), read_only=True)
    assert con.execute("select count(*) from gold.fct_board_history").fetchall() == [(2,)]
    runs = con.sql(
        "select run_id, engine, finished_at from ops.build_log order by run_id"
    ).fetchall()
    assert [(r[0], r[1]) for r in runs] == [("100", None), ("200", "duckdb")]
    assert runs[1][2] == datetime.datetime(2026, 11, 12, 10, 0)


def test_the_seed_without_a_published_build_starts_empty(tmp_path: Path) -> None:
    assert fallback.seed(LocalStore(tmp_path), tmp_path / "x.duckdb", log=lambda _: None) == {}


def test_the_two_roads_agree_when_counts_and_board_values_match(tmp_path: Path) -> None:
    live, candidate = LocalStore(tmp_path / "live"), LocalStore(tmp_path / "candidate")
    _publish(live, "w", "databricks", {"gold.mart_board": _board([3.0, 2.0, 1.0])})
    # the fallback's ledger holds its own run too: listed, not judged
    _publish(
        candidate,
        "d",
        "duckdb",
        {
            "gold.mart_board": _board([3.0 + 1e-12, 2.0, 1.0]),
            "ops.publish_gate": pa.table({"run_id": ["x"]}),
        },
    )
    result = fallback.compare(live, candidate)
    assert result.agrees, fallback.render_comparison(result)
    text = fallback.render_comparison(result)
    assert "The two roads agree" in text and "| ops.publish_gate |  | 1 | own rows |" in text


def test_a_board_value_past_the_tolerance_or_a_missing_row_disagrees(tmp_path: Path) -> None:
    live, candidate = LocalStore(tmp_path / "live"), LocalStore(tmp_path / "candidate")
    _publish(
        live,
        "w",
        "databricks",
        {"gold.mart_board": _board([3.0, 2.0, 1.0]), "gold.dim_team": pa.table({"a": [1, 2]})},
    )
    _publish(
        candidate,
        "d",
        "duckdb",
        {"gold.mart_board": _board([3.0, 2.0 + 1e-6, 1.0]), "gold.dim_team": pa.table({"a": [1]})},
    )
    result = fallback.compare(live, candidate)
    assert not result.agrees
    assert [c[0] for c in result.board_mismatches] == ["value_total"]
    assert result.count_mismatches == [("gold.dim_team", 2, 1)]
    assert "**disagree**" in fallback.render_comparison(result)


def test_a_player_on_one_board_only_disagrees(tmp_path: Path) -> None:
    live, candidate = LocalStore(tmp_path / "live"), LocalStore(tmp_path / "candidate")
    _publish(live, "w", "databricks", {"gold.mart_board": _board([3.0, 2.0, 1.0])})
    _publish(
        candidate, "d", "duckdb", {"gold.mart_board": _board([3.0, 2.0, 1.0], ("1", "2", "4"))}
    )
    result = fallback.compare(live, candidate)
    assert (result.board_only_live, result.board_only_candidate) == (1, 1)
    assert not result.agrees


def test_the_carry_back_inserts_only_missing_rows_naming_and_casting_columns() -> None:
    ledger = fallback.Ledger("gold.fct_board_history", ("board_history_sk",))
    sql = fallback.insert_missing_sql(
        ledger,
        "/Volumes/fantasyscout/raw/landing/_recover/fallback/d/fct_board_history.parquet",
        [("board_history_sk", "string"), ("snapshot_date", "date"), ("added_later", "double")],
        ["board_history_sk", "snapshot_date"],
    )
    assert sql.startswith("insert into gold.fct_board_history (board_history_sk, snapshot_date)")
    assert "cast(k.snapshot_date as date) as snapshot_date" in sql
    assert "added_later" not in sql, "a column the file lacks stays null"
    assert "where not exists (select 1 from gold.fct_board_history as h where" in sql
    assert "h.board_history_sk = k.board_history_sk" in sql
    build_log = fallback.Ledger("ops.build_log", ("run_id", "engine"))
    old = fallback.insert_missing_sql(build_log, "p", [("run_id", "string")], ["run_id"])
    assert "coalesce(h.engine, 'databricks') = 'databricks'" in old
    new = fallback.insert_missing_sql(
        build_log, "p", [("run_id", "string"), ("engine", "string")], ["run_id", "engine"]
    )
    assert "coalesce(h.engine, 'databricks') = coalesce(k.engine, 'databricks')" in new


def test_the_carry_back_offers_the_newest_fallback_build_and_the_volume_rows(
    tmp_path: Path,
) -> None:
    store = LocalStore(tmp_path)
    _publish(store, "d1", "duckdb", _ledgers(datetime.date(2026, 11, 12)))
    _publish(store, "w1", "databricks", _ledgers(datetime.date(2026, 11, 13)))
    uploaded: dict[str, bytes] = {}
    executed: list[str] = []

    def query(sql: str) -> tuple[list[str], list[list[object]]]:
        table = sql.removeprefix("describe table ")
        columns: dict[str, list[list[object]]] = {
            "gold.fct_board_history": [["board_history_sk", "string"], ["snapshot_date", "date"]],
            "ops.publish_gate": [["run_id", "string"], ["passed", "boolean"]],
            "ops.build_log": [["run_id", "string"], ["engine", "string"], ["", ""]],
        }
        return ["col_name", "data_type"], [*columns.get(table, []), ["# Partitioning", ""]]

    def upload(path: PurePosixPath, body: bytes) -> None:
        uploaded[path.as_posix()] = body

    done = fallback.carry_back(
        store,
        None,
        query=query,
        execute=executed.append,
        upload=upload,
        volume_build_log=[{"run_id": "300", "engine": "duckdb", "finished_at": "2026-11-13 1:00"}],
        log=lambda _: None,
    )
    assert sorted(uploaded) == [
        "landing/_recover/fallback/d1/build_log.parquet",
        "landing/_recover/fallback/d1/build_log_volume.parquet",
        "landing/_recover/fallback/d1/fct_board_history.parquet",
        "landing/_recover/fallback/d1/publish_gate.parquet",
    ]
    assert executed[0].strip().startswith("create table if not exists ops.build_log")
    # Databricks does not take "add column if not exists" (#1009): only the missing column, its way
    assert not any(
        "if not exists schedule" in e or "add column if not exists" in e for e in executed
    )
    assert "alter table ops.build_log add columns (schedule_delay_seconds double)" in executed
    inserts = [s for s in executed if s.startswith("insert into")]
    assert len(inserts) == 4 and len(done) == 4
    assert all("where not exists" in s for s in inserts)
    board = next(s for s in inserts if "fct_board_history" in s)
    assert "/Volumes/fantasyscout/raw/landing/_recover/fallback/d1/" in board
    days = pq.read_table(
        io.BytesIO(uploaded["landing/_recover/fallback/d1/fct_board_history.parquet"])
    ).column("snapshot_date")
    assert days.to_pylist() == [datetime.date(2026, 11, 12)] * 2, "the fallback build's days"


def test_nothing_to_carry_back_runs_nothing(tmp_path: Path) -> None:
    executed: list[str] = []
    done = fallback.carry_back(
        LocalStore(tmp_path),
        None,
        query=lambda sql: ([], []),
        execute=executed.append,
        upload=lambda path, body: None,
        volume_build_log=[],
        log=lambda _: None,
    )
    assert done == {} and executed == []


def test_the_command_line_names_the_newest_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    store = LocalStore(tmp_path)
    _publish(store, "w9", "databricks", {"gold.mart_board": _board([1.0, 2.0, 3.0])})
    assert fallback.main(["--published", str(tmp_path), "newest"]) == 0
    assert "build_id: w9" in capsys.readouterr().out
    assert (
        fallback.main(["--published", str(tmp_path), "compare", "--candidate", str(tmp_path)]) == 0
    )
