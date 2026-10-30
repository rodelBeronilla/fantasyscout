from __future__ import annotations

import random

import httpx
import pytest

from ingest.http import (
    CircuitOpenError,
    IngestHTTPError,
    Throttle,
    ThrottledClient,
    stats_headers,
)


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

    def advance(self, seconds: float) -> None:
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


def ok(_: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"ok": True})


def test_stats_headers_point_at_the_league_site() -> None:
    assert stats_headers("wnba")["Referer"] == "https://www.wnba.com/"
    assert stats_headers("nba")["Origin"] == "https://www.nba.com"
    assert stats_headers("nba")["x-nba-stats-origin"] == "stats"


def test_paces_consecutive_requests_to_the_same_host_inside_the_spec_window() -> None:
    client, ft = make_client(ok)
    with client:
        client.get("https://stats.wnba.com/stats/a")
        client.get("https://stats.wnba.com/stats/b")
        client.get("https://site.api.espn.com/x")  # a different host is not delayed
    assert len(ft.sleeps) == 1
    assert 1.5 <= ft.sleeps[0] <= 3.0


def test_gap_shrinks_only_after_a_clean_streak_and_never_below_the_floor() -> None:
    throttle = Throttle.adaptive(min_gap=0.75)
    client, _ft = make_client(ok, throttle)
    changes: list[tuple[float, str]] = []
    client._on_pace_change = lambda host, gap, reason: changes.append((round(gap, 3), reason))
    with client:
        for _ in range(60):
            client.get("https://stats.nba.com/stats/x")
    gaps = [g for g, _ in changes]
    assert changes and all(r == "clean streak" for _, r in changes)
    assert gaps == sorted(gaps, reverse=True), "each speed-up is smaller than the last"
    assert gaps[-1] >= 0.75 and gaps[0] < 2.25
    stats = client.pacing()["stats.nba.com"]
    assert stats["speedups"] == len(changes) and stats["slowdowns"] == 0
    assert stats["final_gap"] >= 0.75 and stats["min_gap"] >= 0.75


def test_spec_policy_never_leaves_its_window() -> None:
    client, ft = make_client(ok, Throttle.spec())
    with client:
        for _ in range(80):
            client.get("https://stats.nba.com/stats/x")
    assert client.pacing()["stats.nba.com"]["min_gap"] >= 1.5
    assert all(1.5 * 0.7 <= s <= 3.0 * 1.3 for s in ft.sleeps)


def test_rate_limit_doubles_the_gap_and_cools_down() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, headers={"retry-after": "20"})
        return httpx.Response(200, json={})

    client, ft = make_client(handler, Throttle.adaptive())
    with client:
        client.get("https://stats.nba.com/stats/x")
    stats = client.pacing()["stats.nba.com"]
    assert stats["rate_limited"] == 1 and stats["slowdowns"] == 1
    assert stats["final_gap"] == 3.0, "doubled from 2.25 and clipped to the ceiling"
    assert max(ft.sleeps) >= 30.0, "cooldown on top of Retry-After"


def test_slow_answers_widen_the_gap() -> None:
    client, ft = make_client(
        lambda _: (ft.advance(4.0), httpx.Response(200, json={}))[1], Throttle.adaptive()
    )
    with client:
        client.get("https://stats.nba.com/stats/x")
    stats = client.pacing()["stats.nba.com"]
    assert stats["slowdowns"] == 1 and stats["final_gap"] == pytest.approx(2.25 * 1.2)


def test_retries_server_errors_then_returns_success() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503) if attempts < 3 else httpx.Response(200, json={})

    client, _ft = make_client(handler)
    with client:
        response = client.get("https://stats.nba.com/stats/x")
    assert response.status_code == 200
    assert attempts == 3
    stats = client.pacing()["stats.nba.com"]
    assert stats["slowdowns"] >= 1 and stats["final_gap"] == 3.0, "widened to the ceiling"


def test_consecutive_timeouts_open_the_circuit() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("silence")

    client, _ft = make_client(handler, Throttle(breaker_timeouts=3, max_retries=5))
    with client, pytest.raises(CircuitOpenError) as excinfo:
        client.get("https://stats.nba.com/stats/x")
    assert excinfo.value.attempts == 3
    assert "likely blocked" in excinfo.value.last


def test_gives_up_after_max_retries_on_connection_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client, _ft = make_client(handler, Throttle(max_retries=2))
    with client, pytest.raises(IngestHTTPError) as excinfo:
        client.get("https://stats.nba.com/stats/x")
    assert not isinstance(excinfo.value, CircuitOpenError)
    assert excinfo.value.attempts == 3
    assert "ConnectError" in excinfo.value.last


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


def test_cookies_set_by_the_host_are_never_sent_back() -> None:
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers.get("cookie", ""))
        return httpx.Response(
            200, json={}, headers={"set-cookie": "ak_bmsc=scored; Domain=.wnba.com; Path=/"}
        )

    client, _ft = make_client(handler)
    with client:
        for _ in range(3):
            client.get("https://stats.wnba.com/stats/x")
        assert client._client.cookies.get("ak_bmsc") == "scored", "the jar did fill up"
    assert sent == ["", "", ""]


def test_adaptive_policy_uses_a_shorter_read_timeout() -> None:
    assert Throttle.adaptive().timeout == 20.0
    assert Throttle.spec().timeout == 30.0


def test_requests_carry_a_browser_user_agent_unless_the_caller_sets_one() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["user-agent"])
        return httpx.Response(200, json={})

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    client.get("https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard")
    client.get("https://example.invalid/x", headers={"User-Agent": "custom"})
    assert seen[0].startswith("Mozilla/5.0") and seen[1] == "custom"
