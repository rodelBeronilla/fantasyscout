"""Bring the SQL warehouse up and wait until it can take statements (#782).

    uv run python -m ops.warehouse start --wait 1200

A build used to send one start request and connect at once: a refused start (HTTP 400 on
2026-11-07, its reason thrown away) or a warehouse still starting failed the whole build when the
first dbt session opened. This polls the warehouse's state until it is RUNNING. It sends a start
whenever it is stopped, and retries a refused start with growing pauses until the wait runs out.
Every refusal is printed with its reason. It exits 1 with the last reason when the warehouse never
comes up, and at once when the warehouse is deleted, which only a person can fix.

Reads DATABRICKS_ORIGIN (or DATABRICKS_HOST), DATABRICKS_WAREHOUSE_ID and DATABRICKS_TOKEN, as
the databricks-context action exports them.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from ingest.store import workspace_origin

RUNNING = "RUNNING"
GONE = frozenset({"DELETED", "DELETING"})
# Pauses after a refused start: 15 s, then doubling to two minutes.
FIRST_PAUSE = 15.0  # def: seconds
LONGEST_PAUSE = 120.0  # def: seconds
POLL = 10.0  # def: seconds between state checks while it starts


@dataclass(frozen=True)
class Outcome:
    running: bool
    state: str
    waited: float
    refusals: list[str]


def _reason(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code} {response.text[:300]}"
    code = body.get("error_code", "")
    message = body.get("message", "")
    return f"HTTP {response.status_code} {code} {message}".strip()


def ensure_running(
    client: httpx.Client,
    origin: str,
    warehouse_id: str,
    *,
    wait: float,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    log: Callable[[str], None] = print,
) -> Outcome:
    """Poll the warehouse until RUNNING, starting it when stopped, for at most ``wait`` seconds."""
    base = f"{origin}/api/2.0/sql/warehouses/{warehouse_id}"
    start = clock()
    pause = FIRST_PAUSE
    refusals: list[str] = []
    state = "UNKNOWN"
    while True:
        got = client.get(base)
        if got.status_code == 200:
            state = str(got.json().get("state", "UNKNOWN"))
        else:
            refusals.append(f"state: {_reason(got)}")
            log(f"could not read the warehouse state: {_reason(got)}")
        waited = clock() - start
        if state == RUNNING:
            log(f"warehouse RUNNING after {waited:.0f} s")
            return Outcome(True, state, waited, refusals)
        if state in GONE:
            log(f"warehouse is {state}: create one and set DATABRICKS_WAREHOUSE_ID")
            return Outcome(False, state, waited, refusals)
        if waited >= wait:
            log(f"warehouse still {state} after {waited:.0f} s; giving up")
            return Outcome(False, state, waited, refusals)
        next_pause = POLL
        if state not in {"STARTING", "STOPPING"}:
            sent = client.post(f"{base}/start")
            if sent.status_code in (200, 204):
                log(f"warehouse {state}: start sent")
            else:
                reason = _reason(sent)
                refusals.append(f"start: {reason}")
                log(f"warehouse {state}: start refused ({reason}); next try in {pause:.0f} s")
                next_pause = pause
                pause = min(pause * 2, LONGEST_PAUSE)
        sleep(min(next_pause, max(wait - waited, 0.0)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start", help="start the warehouse and wait until it is RUNNING")
    start.add_argument("--wait", type=float, default=1200.0, help="seconds to keep trying")
    args = parser.parse_args(argv)
    origin = workspace_origin(
        os.environ.get("DATABRICKS_ORIGIN") or os.environ.get("DATABRICKS_HOST", "")
    )
    warehouse_id = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
    token = os.environ.get("DATABRICKS_TOKEN", "")
    if not (origin and warehouse_id and token):
        print(
            "set DATABRICKS_ORIGIN, DATABRICKS_WAREHOUSE_ID and DATABRICKS_TOKEN", file=sys.stderr
        )
        return 2
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(headers=headers, timeout=60.0) as client:
        outcome = ensure_running(client, origin, warehouse_id, wait=args.wait)
    if not outcome.running:
        last = outcome.refusals[-1] if outcome.refusals else f"state {outcome.state}"
        print(f"::error::the SQL warehouse did not come up: {last}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
