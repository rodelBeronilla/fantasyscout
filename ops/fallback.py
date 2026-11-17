"""The second road: build on DuckDB when the SQL warehouse refuses (#989, ADR 0032).

    uv run python -m ops.fallback newest
    uv run python -m ops.fallback seed --duckdb dbt/fantasyscout.duckdb --landing landing
    uv run python -m ops.fallback compare --candidate site
    uv run python -m ops.fallback carry-back

The Build fallback workflow mirrors the landing volume to a hosted runner (``ops.landing_sync``,
the Files API, no warehouse), builds every model on DuckDB, runs the same gate and quality checks,
and publishes through the same export. A full DuckDB build rebuilds everything from the landing
except the ledgers a rebuild cannot recreate: ``gold.fct_board_history`` (``full_refresh=false``)
and the rows the pipeline writes itself (``ops.test_results``, ``ops.publish_gate``,
``ops.build_log``). The published build carries every one of them as Parquet, so:

- ``seed`` puts the newest published build's ledgers into the DuckDB file before dbt runs, so the
  fallback's build adds its day to the history instead of starting it again. The fallback's own
  ``ops.build_log`` rows are written after its export, so they live as JSON in the volume
  (``landing/_ops/build_log/``, mirrored with ``--ops``) and the next seed adds them.
- ``carry-back`` runs on the warehouse road before dbt: it copies the newest fallback build's
  ledgers into the volume and inserts the rows the lakehouse lacks, so the days the warehouse
  missed stay in the history once it answers again.
- ``compare`` is the parity check: the row count of every table and the board's values of a
  candidate build against the newest published build, to the walk-forward check's 1e-9.
- ``newest`` names the newest published build and its engine (the drill compares only with a
  warehouse build).

Every read of the published bucket goes through a store that refuses writes: nothing here
publishes; the export and the promotion do, as on the warehouse road.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from export.store import LocalStore, R2Store, Store

LATEST_KEY = "latest.json"
BUILDS_KEY = "builds.json"
BUILD_LOG_DIR = PurePosixPath("landing/_ops/build_log")
# Where carry-back puts the Parquet it inserts from: an underscore folder no bronze model reads.
RECOVER_DIR = PurePosixPath("landing/_recover/fallback")
VOLUME_ROOT = "/Volumes/fantasyscout/raw"
# The walk-forward harness's parity tolerance (ops/walk_forward.py, _check_parity).
TOLERANCE = 1e-9
# What the board comparison joins on.
BOARD_KEYS = ("league", "player_id")


@dataclass(frozen=True)
class Ledger:
    table: str  # schema.table
    keys: tuple[str, ...]  # a row's identity, for carrying back only the rows the lakehouse lacks

    @property
    def schema(self) -> str:
        return self.table.split(".", 1)[0]

    @property
    def name(self) -> str:
        return self.table.split(".", 1)[1]


LEDGERS: tuple[Ledger, ...] = (
    Ledger("gold.fct_board_history", ("board_history_sk",)),
    Ledger("ops.test_results", ("run_id", "node_id")),
    Ledger("ops.publish_gate", ("run_id",)),
    Ledger("ops.build_log", ("run_id", "engine")),
)
# Tables each road adds its own rows to, so their counts differ by design: the fallback's ledger
# holds the warehouse's rows plus its own run. The board history is not among them: on the same
# day both roads hold the same days.
OWN_ROWS = frozenset({"ops.test_results", "ops.publish_gate", "ops.build_log"})

Log = Callable[[str], None]


class ReadOnlyStore:
    """The published bucket, read only: a write here is a bug, never a publish."""

    def __init__(self, inner: Store) -> None:
        self._inner = inner

    def get(self, key: str) -> bytes | None:
        return self._inner.get(key)

    def list(self, prefix: str) -> list[str]:
        return self._inner.list(prefix)

    def put(self, key: str, body: bytes) -> None:
        msg = f"refused to write {key}: the fallback's reads never publish"
        raise PermissionError(msg)

    def delete(self, key: str) -> None:
        msg = f"refused to delete {key}: the fallback's reads never publish"
        raise PermissionError(msg)


def _json(store: Store, key: str) -> Any:
    body = store.get(key)
    return json.loads(body) if body else None


def newest_build(store: Store, *, engine: str | None = None) -> dict[str, Any] | None:
    """The newest recorded build (of one engine, when given), else latest.json's."""
    builds: list[dict[str, Any]] = _json(store, BUILDS_KEY) or []
    for entry in builds:
        if engine is None or entry.get("engine") == engine:
            return entry
    latest = _json(store, LATEST_KEY)
    if latest and engine is None:
        return dict(latest)
    return None


def manifest_of(store: Store, build_id: str) -> dict[str, Any]:
    manifest = _json(store, f"builds/{build_id}/manifest.json")
    if not manifest:
        msg = f"build {build_id} has no manifest"
        raise RuntimeError(msg)
    return dict(manifest)


def read_table(store: Store, build_id: str, manifest: Mapping[str, Any], table: str) -> pa.Table:
    """A published table, its Parquet partitions read and joined; empty when it has none."""
    files = [
        f
        for f in (manifest.get("tables", {}).get(table, {}).get("files") or [])
        if str(f).endswith(".parquet")
    ]
    parts: list[pa.Table] = []
    for path in files:
        body = store.get(f"builds/{build_id}/{path}")
        if body is None:
            msg = f"build {build_id} lists {path} but the store has no such file"
            raise RuntimeError(msg)
        parts.append(pq.read_table(io.BytesIO(body)))
    if not parts:
        return pa.table({})
    return pa.concat_tables(parts, promote_options="permissive")


# ---- seed -----------------------------------------------------------------------------------


def build_log_rows(landing: Path) -> list[dict[str, Any]]:
    """The fallback's own build_log rows, as it wrote them to the volume (mirrored with --ops)."""
    folder = landing.joinpath(*BUILD_LOG_DIR.parts)
    if not folder.is_dir():
        return []
    rows = []
    for path in sorted(folder.glob("*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(row, dict) and row.get("run_id"):
            rows.append(row)
    return rows


def seed(
    store: Store, duckdb_path: Path, landing: Path | None = None, *, log: Log = print
) -> dict[str, int]:
    """Put the newest published build's ledgers into the DuckDB file, before dbt builds it.

    Returns the rows seeded per table. A ledger the build does not carry is left to dbt (the
    board history) or to the first write (the ops tables), as on a first build.
    """
    import duckdb  # the fallback road's engine

    entry = newest_build(store)
    if entry is None:
        log("no published build to seed the ledgers from; they start empty")
        return {}
    build_id = str(entry["build_id"])
    manifest = manifest_of(store, build_id)
    log(f"seeding the ledgers from build {build_id} ({manifest.get('engine', '?')})")
    seeded: dict[str, int] = {}
    con = duckdb.connect(str(duckdb_path))
    try:
        for ledger in LEDGERS:
            table = read_table(store, build_id, manifest, ledger.table)
            if table.num_columns == 0:
                log(f"  {ledger.table}: not in the build, starts empty")
                continue
            con.execute(f"create schema if not exists {ledger.schema}")
            con.register("seed_rows", table)
            con.execute(f"create or replace table {ledger.table} as select * from seed_rows")
            con.unregister("seed_rows")
            seeded[ledger.table] = table.num_rows
            log(f"  {ledger.table}: {table.num_rows} rows")
        rows = build_log_rows(landing) if landing else []
        if rows:
            added = _add_build_log_rows(con, rows)
            seeded["ops.build_log (volume)"] = added
            log(f"  ops.build_log: {added} fallback run(s) from the volume")
    finally:
        con.close()
    return seeded


def _add_build_log_rows(con: Any, rows: list[dict[str, Any]]) -> int:
    """Insert the volume's build_log rows the seeded table lacks; how many were added."""
    from ops.build_log import ddl_statements  # the table's one definition

    for statement in ddl_statements("ops"):
        con.execute(statement.replace(" string", " varchar"))
    have = {
        (str(r[0]), str(r[1] or "databricks"))
        for r in con.execute("select run_id, engine from ops.build_log").fetchall()
    }
    columns = [str(c[0]) for c in con.execute("describe ops.build_log").fetchall()]
    added = 0
    for row in rows:
        key = (str(row["run_id"]), str(row.get("engine") or "databricks"))
        if key in have:
            continue
        names = [c for c in columns if c in row]
        marks = ", ".join("?" for _ in names)
        con.execute(
            f"insert into ops.build_log ({', '.join(names)}) values ({marks})",
            [row[c] for c in names],
        )
        have.add(key)
        added += 1
    return added


# ---- compare --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Comparison:
    live_build: str
    candidate_build: str
    counts: list[tuple[str, int | None, int | None]]  # table, live rows, candidate rows
    board_columns: list[tuple[str, float]]  # column, worst absolute difference
    board_only_live: int
    board_only_candidate: int
    tolerance: float = TOLERANCE

    @property
    def count_mismatches(self) -> list[tuple[str, int | None, int | None]]:
        return [c for c in self.counts if c[1] != c[2] and c[0] not in OWN_ROWS]

    @property
    def board_mismatches(self) -> list[tuple[str, float]]:
        return [c for c in self.board_columns if not c[1] <= self.tolerance]

    @property
    def agrees(self) -> bool:
        return (
            not self.count_mismatches
            and not self.board_mismatches
            and not self.board_only_live
            and not self.board_only_candidate
        )


def _numeric(field: pa.Field) -> bool:
    return bool(
        pa.types.is_integer(field.type)
        or pa.types.is_floating(field.type)
        or pa.types.is_decimal(field.type)
    )


def compare_board(live: pa.Table, candidate: pa.Table) -> tuple[list[tuple[str, float]], int, int]:
    """Per numeric column of mart_board, the worst absolute difference between the two builds."""
    key = list(BOARD_KEYS)
    joined = live.join(candidate, keys=key, join_type="inner", right_suffix="__candidate")
    only_live = live.num_rows - joined.num_rows
    only_candidate = candidate.num_rows - joined.num_rows
    shared = [
        f.name
        for f in live.schema
        if f.name not in key
        and _numeric(f)
        and f.name in candidate.schema.names
        and _numeric(candidate.schema.field(f.name))
    ]
    worst: list[tuple[str, float]] = []
    for name in shared:
        a = pc.cast(joined.column(name), pa.float64())
        b = pc.cast(joined.column(f"{name}__candidate"), pa.float64())
        # a value on one side and null on the other is a disagreement as wide as it gets
        one_null = pc.sum(pc.cast(pc.xor(pc.is_null(a), pc.is_null(b)), pa.int64())).as_py() or 0
        diff = pc.max(pc.abs(pc.subtract(a, b))).as_py()
        worst.append((name, float("inf") if one_null else float(diff or 0.0)))
    return worst, only_live, only_candidate


def compare(live: Store, candidate: Store, *, live_build: str | None = None) -> Comparison:
    """A candidate build (the fallback's, in a local store) against a published one."""
    live_entry = {"build_id": live_build} if live_build else newest_build(live)
    cand_entry = newest_build(candidate)
    if live_entry is None or cand_entry is None:
        msg = "nothing to compare: a store has no build"
        raise RuntimeError(msg)
    live_id, cand_id = str(live_entry["build_id"]), str(cand_entry["build_id"])
    live_manifest, cand_manifest = manifest_of(live, live_id), manifest_of(candidate, cand_id)
    live_tables, cand_tables = live_manifest.get("tables", {}), cand_manifest.get("tables", {})
    counts = [
        (
            name,
            live_tables[name]["rows"] if name in live_tables else None,
            cand_tables[name]["rows"] if name in cand_tables else None,
        )
        for name in sorted(set(live_tables) | set(cand_tables))
    ]
    board, only_live, only_candidate = compare_board(
        read_table(live, live_id, live_manifest, "gold.mart_board"),
        read_table(candidate, cand_id, cand_manifest, "gold.mart_board"),
    )
    return Comparison(live_id, cand_id, counts, board, only_live, only_candidate)


def render_comparison(result: Comparison) -> str:
    """Markdown for the step summary: the verdict, then every table and the board's columns."""
    verdict = "agree" if result.agrees else "**disagree**"
    lines = [
        f"## The two roads {verdict}",
        "",
        f"Warehouse build `{result.live_build}` against the DuckDB build"
        f" `{result.candidate_build}`; board values to {result.tolerance:g}. The ledgers each"
        f" road adds its own run to ({', '.join(sorted(OWN_ROWS))}) are listed, not judged.",
        "",
        "| Table | Warehouse rows | DuckDB rows | |",
        "| --- | ---: | ---: | --- |",
    ]
    for name, a, b in result.counts:
        mark = "own rows" if name in OWN_ROWS else ("ok" if a == b else "**differs**")
        live_rows = "" if a is None else f"{a:,}"
        duck_rows = "" if b is None else f"{b:,}"
        lines.append(f"| {name} | {live_rows} | {duck_rows} | {mark} |")
    lines += [
        "",
        f"Board players only in the warehouse build: {result.board_only_live}; only in the DuckDB"
        f" build: {result.board_only_candidate}.",
        "",
        "| Board column | Worst difference | |",
        "| --- | ---: | --- |",
    ]
    for name, worst in result.board_columns:
        mark = "ok" if worst <= result.tolerance else "**differs**"
        lines.append(f"| {name} | {worst:.3g} | {mark} |")
    return "\n".join(lines) + "\n"


# ---- carry-back ------------------------------------------------------------------------------

Query = Callable[[str], tuple[list[str], list[list[object]]]]


def describe_columns(query: Query, table: str) -> list[tuple[str, str]]:
    """(column, type) of a lakehouse table, from ``describe``, stopping at the partition block."""
    _, rows = query(f"describe table {table}")
    out: list[tuple[str, str]] = []
    for row in rows:
        name = str(row[0] or "").strip()
        if not name or name.startswith("#"):
            break
        out.append((name, str(row[1])))
    return out


def insert_missing_sql(
    ledger: Ledger, path: str, columns: list[tuple[str, str]], present: list[str]
) -> str:
    """Insert the file's rows whose keys the table lacks, naming and casting every column."""
    names = [(c, t) for c, t in columns if c in present]
    target = ", ".join(c for c, _ in names)
    values = ", ".join(f"cast(k.{c} as {t}) as {c}" for c, t in names)

    def same(col: str) -> str:
        if col == "engine":  # rows written before the column existed came from the warehouse
            return "coalesce(h.engine, 'databricks') = coalesce(k.engine, 'databricks')"
        return f"h.{col} = k.{col}"

    if "engine" in ledger.keys and "engine" not in present:
        keys = [k for k in ledger.keys if k != "engine"]
        match = " and ".join(
            [*(f"h.{k} = k.{k}" for k in keys), "coalesce(h.engine, 'databricks') = 'databricks'"]
        )
    else:
        match = " and ".join(same(k) for k in ledger.keys)
    return (
        f"insert into {ledger.table} ({target})\n"
        f"select {values}\n"
        f"from parquet.`{path}` as k\n"
        f"where not exists (select 1 from {ledger.table} as h where {match})"
    )


def carry_back(
    store: Store,
    landing: Path | None,
    *,
    query: Query,
    execute: Callable[[str], None],
    upload: Callable[[PurePosixPath, bytes], None],
    volume_build_log: list[dict[str, Any]] | None = None,
    log: Log = print,
) -> dict[str, str]:
    """Insert the newest fallback build's ledger rows that the lakehouse lacks.

    The fallback's build is cumulative (it was seeded from the build before it), so the newest one
    holds every day the warehouse missed. Its build_log rows written after its export come from
    the volume. Every insert skips the rows already present, so running it again adds nothing.
    """
    from ops.build_log import ddl_statements

    entry = newest_build(store, engine="duckdb")
    # (ledger, rows, file name): the fallback build's Parquet, then the volume's build_log rows,
    # which stay a file of their own (their times are text until the insert casts them)
    offers: list[tuple[Ledger, pa.Table, str]] = []
    build_id = "volume"
    if entry is not None:
        build_id = str(entry["build_id"])
        manifest = manifest_of(store, build_id)
        for ledger in LEDGERS:
            table = read_table(store, build_id, manifest, ledger.table)
            if table.num_columns:
                offers.append((ledger, table, f"{ledger.name}.parquet"))
    rows = (
        volume_build_log
        if volume_build_log is not None
        else (build_log_rows(landing) if landing else [])
    )
    if rows:
        build_log = next(ledger for ledger in LEDGERS if ledger.table == "ops.build_log")
        offers.append((build_log, pa.Table.from_pylist(rows), "build_log_volume.parquet"))
    if not offers:
        log("no fallback build and no fallback build_log rows: nothing to carry back")
        return {}
    from ops.build_log import databricks_columns

    for statement in ddl_statements("ops", databricks_columns(query, "ops")):
        execute(statement)
    done: dict[str, str] = {}
    for ledger, table, file_name in offers:
        relative = RECOVER_DIR / build_id / file_name
        sink = io.BytesIO()
        pq.write_table(table, sink)
        upload(relative, sink.getvalue())
        columns = describe_columns(query, ledger.table)
        if not columns:
            log(f"  {ledger.table}: not in the lakehouse yet; its first build creates it")
            continue
        execute(
            insert_missing_sql(ledger, f"{VOLUME_ROOT}/{relative}", columns, table.schema.names)
        )
        done[f"{ledger.table} ({file_name})"] = f"{table.num_rows} rows offered"
        log(f"  {ledger.table}: {table.num_rows} rows offered from {relative}; missing ones added")
    return done


# ---- the command line ------------------------------------------------------------------------


def _r2() -> R2Store:
    return R2Store(
        os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""),
        os.environ.get("CLOUDFLARE_API_TOKEN", ""),
        os.environ.get("R2_BUCKET", "fantasyscout-data"),
    )


def _published(args: argparse.Namespace) -> ReadOnlyStore:
    return ReadOnlyStore(LocalStore(args.published) if args.published else _r2())


def _age_hours(created_at: str, now: datetime | None = None) -> str:
    """Hours since a build was created, to one decimal; empty when unknown."""
    try:
        made = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if made.tzinfo is None:
        made = made.replace(tzinfo=UTC)
    return f"{((now or datetime.now(UTC)) - made).total_seconds() / 3600:.1f}"


def _output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def _write_summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--published",
        type=Path,
        default=None,
        help="a local store standing in for the published bucket (tests; default: R2, read only)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("newest", help="the newest published build and its engine")
    p_seed = sub.add_parser("seed", help="put the published ledgers into the DuckDB file")
    p_seed.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    p_seed.add_argument("--landing", type=Path, default=None, help="the landing mirror's root")
    p_cmp = sub.add_parser("compare", help="a candidate build against the newest published one")
    p_cmp.add_argument("--candidate", type=Path, required=True, help="the candidate's local store")
    p_cmp.add_argument("--live-build", default=None, help="the published build (default: newest)")
    p_cmp.add_argument(
        "--report-only", action="store_true", help="print the comparison, exit 0 either way"
    )
    sub.add_parser("carry-back", help="insert the fallback's ledger rows the lakehouse lacks")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]

    published = _published(args)
    if args.command == "newest":
        entry = dict(newest_build(published) or {})
        entry["age_hours"] = _age_hours(str(entry.get("created_at", "")))
        for name in ("build_id", "engine", "created_at", "age_hours"):
            print(f"{name}: {entry.get(name, '')}")
            _output(name, str(entry.get(name, "")))
        return 0
    if args.command == "seed":
        seed(published, args.duckdb, args.landing)
        return 0
    if args.command == "compare":
        result = compare(published, LocalStore(args.candidate), live_build=args.live_build)
        text = render_comparison(result)
        print(text)
        _write_summary(text)
        _output("agrees", "true" if result.agrees else "false")
        return 0 if result.agrees or args.report_only else 1
    return _carry_back_main(published)


def _carry_back_main(published: Store) -> int:
    from ingest.store import VolumeBackend, credentials_from_env
    from ops.results import write_databricks
    from ops.summary import query_databricks

    env = dict(os.environ)
    origin = env["DATABRICKS_ORIGIN"]
    token = env["DATABRICKS_TOKEN"]
    warehouse = env["DATABRICKS_WAREHOUSE_ID"]
    volume = VolumeBackend(
        env.get("DATABRICKS_HOST") or origin, token, auth=credentials_from_env(env)
    )
    try:
        listed = volume.list_files(BUILD_LOG_DIR)
        rows: list[dict[str, Any]] = []
        for path in listed:
            body = volume.read_bytes(path)
            if body:
                row = json.loads(body)
                if isinstance(row, dict) and row.get("run_id"):
                    rows.append(row)
        carry_back(
            published,
            None,
            query=lambda sql: query_databricks(
                sql, origin=origin, token=token, warehouse_id=warehouse, catalog="fantasyscout"
            ),
            execute=lambda sql: write_databricks(
                [sql], origin=origin, token=token, warehouse_id=warehouse, catalog="fantasyscout"
            ),
            upload=volume.write_bytes,
            volume_build_log=rows,
        )
    finally:
        volume.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
