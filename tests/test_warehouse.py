"""The warehouse is started, waited for, and a refused start is retried with its reason (#782)."""

from __future__ import annotations

import json

import httpx

from ops.warehouse import ensure_running

ORIGIN = "https://ws.example"


class Warehouse:
    """A fake warehouse: refuses `refusals` starts, then starts and runs after `boot` polls."""

    def __init__(self, state: str = "STOPPED", refusals: int = 0, boot: int = 1) -> None:
        self.state = state
        self.refusals = refusals
        self.boot = boot
        self.starts = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            self.starts += 1
            if self.refusals:
                self.refusals -= 1
                body = {"error_code": "BAD_REQUEST", "message": "Cannot create the resource"}
                return httpx.Response(400, content=json.dumps(body))
            self.state = "STARTING"
            return httpx.Response(200, content="{}")
        if self.state == "STARTING":
            self.boot -= 1
            if self.boot < 0:
                self.state = "RUNNING"
        return httpx.Response(200, content=json.dumps({"state": self.state}))


def _run(wh: Warehouse, wait: float = 600.0) -> tuple[object, list[float], list[str]]:
    now = [0.0]
    pauses: list[float] = []
    lines: list[str] = []

    def sleep(s: float) -> None:
        pauses.append(s)
        now[0] += s

    client = httpx.Client(transport=httpx.MockTransport(wh.handler))
    out = ensure_running(
        client, ORIGIN, "w1", wait=wait, sleep=sleep, clock=lambda: now[0], log=lines.append
    )
    return out, pauses, lines


def test_a_running_warehouse_is_left_alone() -> None:
    wh = Warehouse(state="RUNNING")
    out, pauses, _ = _run(wh)
    assert out.running and wh.starts == 0 and pauses == []  # type: ignore[attr-defined]


def test_a_stopped_warehouse_is_started_and_waited_for() -> None:
    wh = Warehouse(boot=2)
    out, pauses, _ = _run(wh)
    assert out.running  # type: ignore[attr-defined]
    assert wh.starts == 1
    assert pauses == [10.0, 10.0, 10.0]


def test_a_refused_start_is_retried_with_growing_pauses_and_its_reason() -> None:
    wh = Warehouse(refusals=3)
    out, pauses, lines = _run(wh)
    assert out.running  # type: ignore[attr-defined]
    assert wh.starts == 4
    assert pauses[:3] == [15.0, 30.0, 60.0]
    assert any("Cannot create the resource" in line for line in lines)


def test_it_gives_up_with_the_reason_when_the_wait_runs_out() -> None:
    wh = Warehouse(refusals=100)
    out, pauses, _ = _run(wh, wait=200.0)
    assert not out.running  # type: ignore[attr-defined]
    assert sum(pauses) <= 200.0
    assert "Cannot create the resource" in out.refusals[-1]  # type: ignore[attr-defined]


def test_a_deleted_warehouse_fails_at_once() -> None:
    wh = Warehouse(state="DELETED")
    out, pauses, _ = _run(wh)
    assert not out.running and out.state == "DELETED" and pauses == []  # type: ignore[attr-defined]
