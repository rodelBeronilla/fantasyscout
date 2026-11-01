"""Sidecars say what a request cost and which run made it; runs count by endpoint (#263)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path

import httpx

from ingest.http import RequestStats, Throttle, ThrottledClient
from ingest.landing import Sidecar
from ingest.run import RunSummary
from ingest.stats import StatsIngestor, StatsPlanner
from ingest.store import Landing, LocalBackend, Scope
from tests.test_stats import fixture
from tests.test_store import SCOPE


def test_the_client_remembers_the_attempts_and_latency_of_its_last_request() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503 if calls["n"] == 1 else 200, content=b"ok")

    ticks = iter([0.0, 0.0, 0.4, 1.0, 1.0, 1.25, 2.0, 2.0, 2.0])
    client = ThrottledClient(
        Throttle(max_retries=1),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: next(ticks),
    )
    assert client.last_request is None
    assert client.get("https://stats.example/x").status_code == 200
    assert client.last_request is not None
    assert client.last_request.attempts == 2
    assert client.last_request.latency_ms >= 0


def test_the_sidecar_carries_the_request_cost_and_the_run_id(tmp_path: Path) -> None:
    landing = Landing(
        LocalBackend(tmp_path),
        ingest_date=date(2026, 10, 27),
        run_id="run-xyz",
        request_stats=lambda: RequestStats(attempts=3, latency_ms=812),
    )
    result = landing.land(
        SCOPE, "k", b"body", url="u", params={}, status=200, fetched_at=datetime.now(UTC)
    )
    landing.flush()
    assert result.endpoint == "leaguegamelog" and result.key == "k"
    sidecar = json.loads((tmp_path / result.path).with_suffix(".meta.json").read_text())
    assert (
        sidecar["latency_ms"] == 812 and sidecar["attempts"] == 3 and sidecar["run_id"] == "run-xyz"
    )
    # A sidecar written before these fields existed still reads.
    old = {k: v for k, v in sidecar.items() if k not in ("latency_ms", "attempts", "run_id")}
    parsed = Sidecar.model_validate(old)
    assert parsed.latency_ms is None and parsed.attempts is None and parsed.run_id is None


def test_the_run_summary_counts_by_endpoint(tmp_path: Path) -> None:
    summary = RunSummary("stats", "wnba", "2026", datetime.now(UTC))
    landing = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27))
    summary.record(
        landing.land(SCOPE, "a", b"1", url="u", params={}, status=200, fetched_at=datetime.now(UTC))
    )
    summary.record(
        landing.land(SCOPE, "a", b"1", url="u", params={}, status=200, fetched_at=datetime.now(UTC))
    )
    box = Scope("stats", "boxscoretraditionalv3", "wnba", "2026")
    summary.record(
        landing.land(box, "g1", b"2", url="u", params={}, status=200, fetched_at=datetime.now(UTC))
    )
    summary.fail("boxscoretraditionalv3", "g2", RuntimeError("HTTP 500"))
    summary.miss("summary", "e1", "HTTP 404")
    summary.record(None)
    assert summary.endpoints == {
        "leaguegamelog": {"landed": 1, "unchanged": 1},
        "boxscoretraditionalv3": {"landed": 1, "failed": 1},
        "summary": {"missing": 1},
    }
    assert summary.to_dict()["endpoints"]["leaguegamelog"] == {"landed": 1, "unchanged": 1}
    assert summary.skipped == 1


def test_a_stats_run_stamps_every_sidecar(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=fixture(request.url.path.rsplit("/", 1)[-1]))

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
    )
    landing = Landing(
        LocalBackend(tmp_path),
        ingest_date=date(2026, 10, 27),
        run_id="abc",
        request_stats=lambda: client.last_request,
    )
    summary = StatsIngestor(
        client, landing, StatsPlanner("wnba", "2026"), now=datetime(2026, 10, 27, tzinfo=UTC)
    ).run()
    assert summary.ok and summary.endpoints["boxscoretraditionalv3"]["landed"] >= 1
    sidecars = list((tmp_path / "landing/stats").rglob("*.meta.json"))
    assert sidecars
    for path in sidecars:
        meta = json.loads(path.read_text())
        assert meta["run_id"] == "abc" and meta["attempts"] == 1 and meta["latency_ms"] >= 0
