"""One connection for every notebook, whichever copy of gold is at hand.

    from fs import connect
    con = connect()            # picks a source (see below)
    con.sql("select count(*) from fct_shot")

Sources, chosen by FS_NOTEBOOK_SOURCE or, when unset, in this order:

- ``published``: the site's current data build, read over HTTP with DuckDB's Parquet reader.
  Needs nothing but a network connection; this is what the build workflow uses.
- ``local``: the dbt DuckDB file (``dbt/fantasyscout.duckdb``), when it exists. CI uses this
  with the fixture sample to prove the notebooks execute.
- ``databricks``: the lakehouse through ``databricks-sql-connector`` (DATABRICKS_HOST,
  DATABRICKS_HTTP_PATH, DATABRICKS_TOKEN), copied into an in-memory DuckDB.

Every gold and ops table is a view with its bare name (``fct_shot``, ``mart_board``,
``reconciliation_summary``), so the notebooks read the same way on all three.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

import duckdb

SITE = os.environ.get("FS_SITE_URL", "https://fantasyscout.beronilla.rodeo").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
LOCAL_DB = ROOT / "dbt" / "fantasyscout.duckdb"
_NOTES: dict[int, str] = {}

OPS_TABLES = frozenset(
    {
        "reconciliation_summary",
        "reconciliation",
        "ingest_log",
        "publish_gate",
        "test_results",
        "category_config",
    }
)
TABLES = (
    "dim_date",
    "dim_team",
    "dim_game",
    "dim_player",
    "fct_player_game",
    "fct_team_game",
    "fct_event",
    "fct_shot",
    "fct_availability",
    "mart_board",
    "mart_category_zscores",
    "mart_player_rolling",
    "mart_streamers",
    "reconciliation_summary",
    "reconciliation",
    "ingest_log",
    "publish_gate",
    "test_results",
    "category_config",
)


USER_AGENT = "fantasyscout-notebooks/1.0 (+https://github.com/rodelBeronilla/fantasyscout)"


def _get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def connect(source: str | None = None) -> duckdb.DuckDBPyConnection:
    source = (
        source
        or os.environ.get("FS_NOTEBOOK_SOURCE")
        or ("local" if LOCAL_DB.exists() else "published")
    )
    con = duckdb.connect()
    if source == "local":
        con.execute(f"attach '{LOCAL_DB.as_posix()}' as lake (read_only)")
        present = con.execute(
            "select table_schema, table_name from information_schema.tables "
            "where table_catalog = 'lake' and table_schema in ('gold', 'ops')"
        ).fetchall()
        for schema, table in present:
            if table in TABLES:
                con.execute(f"create view {table} as select * from lake.{schema}.{table}")
        _NOTES[id(con)] = "Reading the local dbt DuckDB file."
        return con
    if source == "published":
        pinned = os.environ.get(
            "FS_BUILD_ID"
        )  # the build workflow pins the build it just published
        latest = (
            {"build_id": pinned, "manifest": f"builds/{pinned}/manifest.json"}
            if pinned
            else _get_json(f"{SITE}/data/latest.json")
        )
        manifest = _get_json(f"{SITE}/data/{latest['manifest']}")
        base = f"{SITE}/data/builds/{latest['build_id']}"
        con.execute("install httpfs; load httpfs")
        for table, info in manifest["tables"].items():
            name = table.split(".", 1)[1]
            files = [f"'{base}/{f}'" for f in info["files"] if f.endswith(".parquet")]
            if files:
                con.execute(
                    f"create view {name} as select * from read_parquet([{', '.join(files)}])"
                )
        _NOTES[id(con)] = f"Reading the published build {latest['build_id']} from {SITE}."
        return con
    if source == "databricks":
        from databricks import sql  # type: ignore[import-not-found]

        with sql.connect(
            server_hostname=os.environ["DATABRICKS_HOST"].replace("https://", "").split("/")[0],
            http_path=os.environ["DATABRICKS_HTTP_PATH"],
            access_token=os.environ["DATABRICKS_TOKEN"],
        ) as dbx:
            for table in TABLES:
                schema = "ops" if table in OPS_TABLES else "gold"
                with dbx.cursor() as cur:
                    cur.execute(f"select * from fantasyscout.{schema}.{table}")
                    arrow = cur.fetchall_arrow()
                con.register(table, arrow)
        _NOTES[id(con)] = "Reading the lakehouse through the Databricks SQL connector."
        return con
    msg = f"unknown source {source!r}; use published, local or databricks"
    raise ValueError(msg)


def describe(con: duckdb.DuckDBPyConnection) -> str:
    """A one-line note of what the notebook read, for its first cell."""
    return _NOTES.get(id(con), "Reading an in-memory copy of the gold tables.")


def leagues(con: duckdb.DuckDBPyConnection) -> list[str]:
    """The leagues present in this copy of gold, WNBA first."""
    found = {r[0] for r in con.sql("select distinct league from fct_player_game").fetchall()}
    return [lg for lg in ("wnba", "nba") if lg in found]


def save_findings(name: str, findings: dict) -> Path:
    """Headline findings next to the rendered notebook, for the site's Notebooks page.

    The shape is {"title", "leagues": {league: {"headline", "facts": [{"label", "value"}],
    "table": {"columns": [...], "rows": [[...]]}}}}; values are plain JSON.
    """
    out = Path.cwd() / "_build"
    out.mkdir(exist_ok=True)
    path = out / f"{name}.findings.json"
    path.write_text(json.dumps(findings, default=str, indent=1), encoding="utf-8")
    return path
