from __future__ import annotations

import random

import httpx
import pytest

from ingest.http import IngestHTTPError, Throttle, ThrottledClient, stats_headers


class FakeTime:
    """A clock and sleep that advance together, so pacing is observable without waiting."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def make_client(
    handler: object, throttle: Throttle | None = None, seed: int = 1
) -> tuple[ThrottledClient, FakeTime]:
    ft = FakeTime()
    client = ThrottledClient(
        throttle,
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
        sleep=ft.sleep,
        clock=ft.clock,
        rng=random.Random(seed),
    )
    return client, ft


def test_stats_headers_point_at_the_league_site() -> None:
    assert stats_headers("wnba")["Referer"] == "https://www.wnba.com/"
    assert stats_headers("nba")["Origin"] == "https://www.nba.com"
    assert stats_headers("nba")["x-nba-stats-origin"] == "stats"


def test_paces_consecutive_requests_to_the_same_host() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={"ok": True})

    client, ft = make_client(handler)
    with client:
        client.get("https://stats.wnba.com/stats/a")
        client.get("https://stats.wnba.com/stats/b")
        client.get("https://site.api.espn.com/x")  # a different host is not delayed
    assert len(calls) == 3
    assert len(ft.sleeps) == 1
    assert 1.5 <= ft.sleeps[0] <= 3.0


def test_retries_retryable_statuses_then_returns_success() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503) if attempts < 3 else httpx.Response(200, json={})

    client, ft = make_client(handler)
    with client:
        response = client.get("https://stats.nba.com/stats/x")
    assert response.status_code == 200
    assert attempts == 3
    # two backoffs (1s*2^0, 1s*2^1 plus jitter) interleaved with pacing sleeps
    backoffs = [s for s in ft.sleeps if s >= 1.0]
    assert len(backoffs) >= 2


def test_honours_retry_after() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, headers={"retry-after": "20"})
        return httpx.Response(200, json={})

    client, ft = make_client(handler)
    with client:
        client.get("https://stats.nba.com/stats/x")
    assert max(ft.sleeps) >= 20.0


def test_gives_up_after_max_retries() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("blocked")

    client, _ft = make_client(handler, Throttle(max_retries=2))
    with client, pytest.raises(IngestHTTPError) as excinfo:
        client.get("https://stats.nba.com/stats/x")
    assert excinfo.value.attempts == 3
    assert "ConnectTimeout" in excinfo.value.last


def test_non_retryable_errors_are_returned_not_retried() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(403)

    client, _ = make_client(handler)
    with client:
        response = client.get("https://stats.nba.com/stats/x")
    assert response.status_code == 403
    assert attempts == 1
