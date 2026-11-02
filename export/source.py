"""Where the export reads gold from: the local DuckDB file or the Databricks SQL warehouse.

Both sources answer the same two calls and hand back Arrow tables, so everything downstream
(Parquet, JSON, the per-player files) is engine-agnostic. Databricks results come through the
SQL Statement Execution API as Arrow IPC streams on pre-signed links, which is the way to move
millions of rows out of a warehouse without a driver.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import httpx
import pyarrow as pa
import pyarrow.ipc


class GoldSource(Protocol):
    def query(self, sql: str) -> pa.Table: ...

    def close(self) -> None: ...


class DuckDBSource:
    """Reads the dbt DuckDB file (CI, local development)."""

    def __init__(self, path: Path) -> None:
        import duckdb

        self._con = duckdb.connect(str(path), read_only=True)

    def query(self, sql: str) -> pa.Table:
        return self._con.sql(sql).to_arrow_table()

    def close(self) -> None:
        self._con.close()


# A serverless warehouse waking from auto-stop refuses statements with HTTP 400 "The request could
# not be processed by the warehouse."; 429 and 5xx are the API's own transient answers. A refused
# submission is retried with a growing pause, about five minutes in all: on 2026-11-01 an export's
# three attempts met nine minutes of refusals (#366, #402). The gate and the summary queries
# (ops.results, ops.summary) use the same rule.
TRANSIENT_SUBMISSION = "could not be processed by the warehouse"
SUBMISSION_PAUSES: tuple[float, ...] = (5.0, 10.0, 20.0, 30.0, 60.0, 60.0, 60.0, 60.0)


def is_transient(response: httpx.Response) -> bool:
    """A submission answer worth retrying: rate limited, a server error, a warehouse waking up."""
    if response.status_code == 429 or response.status_code >= 500:
        return True
    return response.status_code == 400 and TRANSIENT_SUBMISSION in response.text


def submit_with_retry(
    post: Callable[[], httpx.Response], sleep: Callable[[float], None] = time.sleep
) -> httpx.Response:
    """Submit, and resubmit after each pause while the answer is transient; the last answer."""
    response = post()
    for pause in SUBMISSION_PAUSES:
        if response.status_code == 200 or not is_transient(response):
            break
        print(
            f"  statement submission answered HTTP {response.status_code}; "
            f"the warehouse may be starting, retrying in {pause:g}s"
        )
        sleep(pause)
        response = post()
    return response


class DatabricksSource:
    """Reads the lakehouse through the SQL Statement Execution API (Arrow, external links)."""

    def __init__(
        self,
        origin: str,
        token: str,
        warehouse_id: str,
        *,
        catalog: str = "fantasyscout",
        transport: httpx.BaseTransport | None = None,
        link_transport: httpx.BaseTransport | None = None,
        sleep: float = 2.0,
        pause: Callable[[float], None] = time.sleep,
    ) -> None:
        if not warehouse_id:
            msg = "warehouse_id is empty; export DATABRICKS_WAREHOUSE_ID"
            raise RuntimeError(msg)
        self._api = httpx.Client(
            base_url=origin,
            headers={"Authorization": f"Bearer {token}"},
            timeout=120,
            transport=transport,
        )
        # Pre-signed links must be fetched without the workspace token.
        self._links = httpx.Client(timeout=300, transport=link_transport)
        self._warehouse_id = warehouse_id
        self._catalog = catalog
        self._sleep = sleep
        self._pause = pause

    def close(self) -> None:
        self._api.close()
        self._links.close()

    def query(self, sql: str) -> pa.Table:
        submission = {
            "warehouse_id": self._warehouse_id,
            "catalog": self._catalog,
            "statement": sql,
            "wait_timeout": "30s",
            "format": "ARROW_STREAM",
            "disposition": "EXTERNAL_LINKS",
        }
        response = submit_with_retry(
            lambda: self._api.post("/api/2.0/sql/statements", json=submission), self._pause
        )
        if response.status_code != 200:
            msg = f"statement submission failed: HTTP {response.status_code} {response.text[:500]}"
            raise RuntimeError(msg)
        body = response.json()
        statement_id = body["statement_id"]
        state = body["status"]["state"]
        while state in ("PENDING", "RUNNING"):
            time.sleep(self._sleep)
            body = self._api.get(f"/api/2.0/sql/statements/{statement_id}").json()
            state = body["status"]["state"]
        if state != "SUCCEEDED":
            error = body.get("status", {}).get("error", {}).get("message", "")[:300]
            msg = f"statement failed ({state}): {error}"
            raise RuntimeError(msg)

        columns = [c["name"] for c in body.get("manifest", {}).get("schema", {}).get("columns", [])]
        links = list(body.get("result", {}).get("external_links", []))
        batches: list[pa.Table] = []
        while links:
            link = links.pop(0)
            payload = self._links.get(link["external_link"])
            payload.raise_for_status()
            if payload.content:
                reader = pyarrow.ipc.open_stream(payload.content)
                batches.append(reader.read_all())
            next_index = link.get("next_chunk_index")
            if next_index is not None and not links:
                chunk = self._api.get(
                    f"/api/2.0/sql/statements/{statement_id}/result/chunks/{next_index}"
                ).json()
                links.extend(chunk.get("external_links", []))
        if not batches:
            return pa.table({name: pa.array([], type=pa.string()) for name in columns})
        return pa.concat_tables(batches, promote_options="default")
