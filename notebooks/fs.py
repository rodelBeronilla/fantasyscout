"""One connection for every notebook, whichever copy of gold is at hand.

    from fs import connect
    con = connect()            # picks a source (see below)
    con.sql("select count(*) from fct_shot")

Sources, chosen by FS_NOTEBOOK_SOURCE or, when unset, in this order:

- ``published``: the site's current data build, read over HTTP with DuckDB's Parquet reader.
  Needs nothing but a network connection; this is what the build workflow uses.
- ``local``: the dbt DuckDB file (``dbt/fantasyscout.duckdb``, or the file ``FS_LOCAL_DB``
  names), when it exists. CI uses this with the fixture sample to prove the notebooks execute.
- ``databricks``: the lakehouse through ``databricks-sql-connector`` (DATABRICKS_HOST,
  DATABRICKS_HTTP_PATH, DATABRICKS_TOKEN), copied into an in-memory DuckDB.

Every gold and ops table is a view with its bare name (``fct_shot``, ``mart_board``,
``reconciliation_summary``), so the notebooks read the same way on all three.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import urllib.request
from pathlib import Path

import duckdb

SITE = os.environ.get("FS_SITE_URL", "https://fantasyscout.beronilla.rodeo").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
LOCAL_DB = Path(os.environ.get("FS_LOCAL_DB") or ROOT / "dbt" / "fantasyscout.duckdb")
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
    "fct_injury_status",
    "fct_player_status",
    "fct_transaction",
    "fct_player_news",
    "fct_team_game_context",
    "fct_market_value",
    "fct_waiver_trend",
    "fct_official_listing",
    "fct_player_tracking",
    "fct_game_official",
    "fct_referee_tendency",
    "fct_board_history",
    "fct_game_line",
    "fct_player_prop",
    "fct_team_stakes",
    "mart_board",
    "mart_player_projection",
    "mart_category_zscores",
    "mart_player_rolling",
    "mart_streamers",
    "mart_schedule_upcoming",
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
        # The Parquet tables are private to the site's owner (ADR 0008). CI reads them with a key
        # derived from the Yahoo client secret it holds; the Worker derives the same (owner.ts).
        secret = os.environ.get("FS_READER_SECRET", "")
        if secret:
            key = hmac.new(secret.encode(), b"fantasyscout ci reader", hashlib.sha256).hexdigest()
            con.execute(
                "create secret fs_owner (type http, scope '"
                + SITE
                + "', extra_http_headers map {'Authorization': 'Bearer "
                + key
                + "'})"
            )
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
                    try:
                        cur.execute(f"select * from fantasyscout.{schema}.{table}")
                    except Exception:  # a table this lakehouse has not built yet
                        continue
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


def has_table(con: duckdb.DuckDBPyConnection, name: str) -> bool:
    """Whether this copy of gold carries a table (an older build may predate it)."""
    rows = con.execute(
        "select count(*) from information_schema.tables where table_name = ?", [name]
    ).fetchall()
    return bool(rows and rows[0][0])


def columns(con: duckdb.DuckDBPyConnection, name: str) -> set[str]:
    """The columns of a table; empty when the table is missing."""
    if not has_table(con, name):
        return set()
    return {r[0] for r in con.sql(f"describe {name}").fetchall()}


def insufficient(reason: str, n: int = 0, n_label: str = "observations") -> dict:
    """League findings saying the build does not hold enough history yet, instead of zeros."""
    return {
        "headline": reason,
        "facts": [],
        "table": {"columns": [], "rows": []},
        "n": int(n),
        "n_label": n_label,
        "insufficient_history": True,
    }


def save_findings(name: str, findings: dict) -> Path:
    """Headline findings next to the rendered notebook, for the site's Notebooks page.

    The shape is {"title", "leagues": {league: {"headline", "facts": [{"label", "value"}],
    "table": {"columns": [...], "rows": [[...]]}, "n", "n_label", "insufficient_history"}}};
    values are plain JSON. ``n`` (described by ``n_label``) is how much evidence the findings
    rest on; ``insufficient_history`` marks a league this build cannot answer for yet, which the
    page shows as accumulating rather than as a row of zeros.
    """
    out = Path.cwd() / "_build"
    out.mkdir(exist_ok=True)
    path = out / f"{name}.findings.json"
    path.write_text(json.dumps(findings, default=str, indent=1), encoding="utf-8")
    return path
