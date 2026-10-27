"""Throttled, retrying HTTP client shared by every ingestor.

Implements the rules in SPEC.md ("Rules for every ingestor"): one request at a time per
host, a randomized gap between requests to the same host, exponential backoff with jitter
on transport errors and retryable statuses, at most five retries, and the browser-like
headers the league stats API expects. `Retry-After` is honoured when present.

The gap is adaptive (``Throttle``): it starts at the spec's midpoint and, while the host
answers quickly and cleanly, shrinks gently towards ``min_gap``; any 429, server error,
transport error or slow response widens it at once. Consecutive silent timeouts are the
signature of an address block, so after ``breaker_timeouts`` of them the client opens its
circuit and raises ``CircuitOpenError`` instead of continuing to hammer the host.

Cookies are never sent back. The stats hosts sit behind a bot manager that sets scoring
cookies on every answer; once a long-lived client's cookie is scored badly, every request
carrying it is accepted and then left unanswered until the read timeout, on fresh connections
too. A cookie-less request from the same address keeps answering in well under a second, so
the client clears its jar before each attempt.
"""

from __future__ import annotations

import contextlib
import random
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Literal

import httpx

League = Literal["wnba", "nba"]

RETRY_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

_LEAGUE_SITE: dict[League, str] = {"wnba": "https://www.wnba.com", "nba": "https://www.nba.com"}


def stats_headers(league: League) -> dict[str, str]:
    """Headers the stats.wnba.com / stats.nba.com endpoints require before they answer."""
    site = _LEAGUE_SITE[league]
    return {
        "User-Agent": _USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": site,
        "Referer": f"{site}/",
        "x-nba-stats-origin": "stats",
        "x-nba-stats-token": "true",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
    }


@dataclass(frozen=True)
class Throttle:
    """Pacing and retry policy.

    ``spec()`` is the daily policy from SPEC.md: the gap stays inside 1.5-3 s. ``adaptive()``
    is the backfill policy: same start and ceiling, a lower floor the client only reaches by
    earning it, one clean fast response at a time.
    """

    min_gap: float = 1.5
    max_gap: float = 3.0
    start_gap: float = 2.25
    jitter: float = 0.3  # +-30 % around the current gap
    speedup_after: int = 10  # consecutive clean, fast responses before the gap shrinks
    speedup_factor: float = 0.9
    slowdown_429: float = 2.0
    slowdown_error: float = 1.5
    slow_latency: float = 3.0  # seconds; a slower answer is treated as strain
    slow_factor: float = 1.2
    cooldown_429: float = 30.0  # extra pause after a 429, on top of Retry-After
    breaker_timeouts: int = 3  # consecutive timeouts that open the circuit
    max_retries: int = 5
    backoff_base: float = 1.0
    backoff_cap: float = 60.0
    timeout: float = 30.0

    @classmethod
    def spec(cls) -> Throttle:
        return cls()

    @classmethod
    def adaptive(cls, min_gap: float = 0.75) -> Throttle:
        # A shorter read timeout: on a healthy host the slowest answer is a few seconds, and
        # with the breaker at three timeouts an unanswering host stops a run in about a minute.
        return cls(min_gap=min_gap, timeout=20.0)


class IngestHTTPError(Exception):
    """Raised when a request still fails after every retry."""

    def __init__(self, url: str, attempts: int, last: str) -> None:
        super().__init__(f"{url}: gave up after {attempts} attempts ({last})")
        self.url = url
        self.attempts = attempts
        self.last = last


class CircuitOpenError(IngestHTTPError):
    """The host stopped answering (consecutive timeouts): stop the run, do not hammer it."""


@dataclass
class HostState:
    """What the client has learned about one host so far."""

    gap: float
    last_request: float | None = None
    clean_streak: int = 0
    timeouts_in_a_row: int = 0
    requests: int = 0
    speedups: int = 0
    slowdowns: int = 0
    rate_limited: int = 0
    min_gap_seen: float = field(default=0.0)
    max_gap_seen: float = field(default=0.0)

    def __post_init__(self) -> None:
        self.min_gap_seen = self.gap
        self.max_gap_seen = self.gap

    def _set_gap(self, gap: float, lo: float, hi: float) -> None:
        self.gap = min(hi, max(lo, gap))
        self.min_gap_seen = min(self.min_gap_seen, self.gap)
        self.max_gap_seen = max(self.max_gap_seen, self.gap)

    def snapshot(self) -> dict[str, float | int]:
        return {
            "requests": self.requests,
            "final_gap": round(self.gap, 3),
            "min_gap": round(self.min_gap_seen, 3),
            "max_gap": round(self.max_gap_seen, 3),
            "speedups": self.speedups,
            "slowdowns": self.slowdowns,
            "rate_limited": self.rate_limited,
        }


class ThrottledClient:
    """Synchronous client that paces requests per host, adapts the pace, and retries politely.

    `sleep`, `clock` and `rng` are injectable so tests run instantly and deterministically.
    """

    def __init__(
        self,
        throttle: Throttle | None = None,
        *,
        headers: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
        on_pace_change: Callable[[str, float, str], None] | None = None,
    ) -> None:
        self.throttle = throttle or Throttle.spec()
        self._client = httpx.Client(
            timeout=self.throttle.timeout,
            headers=dict(headers or {}),
            transport=transport,
            follow_redirects=False,
        )
        self._sleep = sleep
        self._clock = clock
        self._rng = rng or random.Random()
        self._on_pace_change = on_pace_change
        self._hosts: dict[str, HostState] = {}
        self._host_locks: dict[str, threading.Lock] = {}
        self._registry_lock = threading.Lock()

    def __enter__(self) -> ThrottledClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def pacing(self) -> dict[str, dict[str, float | int]]:
        """Per-host pacing statistics for the run log."""
        return {host: state.snapshot() for host, state in self._hosts.items()}

    def _state(self, host: str) -> HostState:
        with self._registry_lock:
            if host not in self._hosts:
                self._hosts[host] = HostState(gap=self.throttle.start_gap)
                self._host_locks[host] = threading.Lock()
            return self._hosts[host]

    def _lock_for(self, host: str) -> threading.Lock:
        self._state(host)
        return self._host_locks[host]

    def _change_gap(self, host: str, state: HostState, factor: float, reason: str) -> None:
        before = state.gap
        state._set_gap(state.gap * factor, self.throttle.min_gap, self.throttle.max_gap)
        state.clean_streak = 0
        if state.gap < before:
            state.speedups += 1
        elif state.gap > before:
            state.slowdowns += 1
        if self._on_pace_change is not None and state.gap != before:
            self._on_pace_change(host, state.gap, reason)

    def _pace(self, host: str, state: HostState) -> None:
        """Wait until the current randomized gap since the last request to this host has passed."""
        if state.last_request is not None:
            j = self.throttle.jitter
            gap = state.gap * self._rng.uniform(1 - j, 1 + j)
            wait = state.last_request + gap - self._clock()
            if wait > 0:
                self._sleep(wait)
        state.last_request = self._clock()
        state.requests += 1

    def _backoff(self, attempt: int, retry_after: str | None) -> None:
        delay = min(self.throttle.backoff_cap, self.throttle.backoff_base * 2**attempt)
        delay += self._rng.uniform(0, 1)
        if retry_after is not None:
            with contextlib.suppress(ValueError):
                delay = max(delay, float(retry_after))
        self._sleep(delay)

    def _on_success(self, host: str, state: HostState, latency: float) -> None:
        state.timeouts_in_a_row = 0
        if latency > self.throttle.slow_latency:
            self._change_gap(host, state, self.throttle.slow_factor, f"slow answer {latency:.1f}s")
            return
        state.clean_streak += 1
        if state.clean_streak >= self.throttle.speedup_after and state.gap > self.throttle.min_gap:
            self._change_gap(host, state, self.throttle.speedup_factor, "clean streak")

    def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        """GET with adaptive pacing and retries. Returns any non-retryable response, even 4xx."""
        host = httpx.URL(url).host
        state = self._state(host)
        attempts = self.throttle.max_retries + 1
        last = "no attempt made"
        with self._lock_for(host):
            for attempt in range(attempts):
                self._pace(host, state)
                self._client.cookies.clear()
                started = self._clock()
                try:
                    response = self._client.get(url, params=params, headers=headers)
                except httpx.TimeoutException as exc:
                    last = f"{type(exc).__name__}: {exc}"
                    state.timeouts_in_a_row += 1
                    self._change_gap(host, state, self.throttle.slowdown_error, "timeout")
                    if state.timeouts_in_a_row >= self.throttle.breaker_timeouts:
                        raise CircuitOpenError(
                            url,
                            attempt + 1,
                            f"{state.timeouts_in_a_row} consecutive timeouts; the host is not "
                            "answering this address (likely blocked), stopping",
                        ) from exc
                    if attempt + 1 < attempts:
                        self._backoff(attempt, None)
                    continue
                except httpx.TransportError as exc:
                    last = f"{type(exc).__name__}: {exc}"
                    self._change_gap(host, state, self.throttle.slowdown_error, "transport error")
                    if attempt + 1 < attempts:
                        self._backoff(attempt, None)
                    continue
                latency = self._clock() - started
                if response.status_code == 429:
                    last = "HTTP 429"
                    state.rate_limited += 1
                    state.timeouts_in_a_row = 0
                    self._change_gap(host, state, self.throttle.slowdown_429, "rate limited")
                    if attempt + 1 < attempts:
                        self._backoff(attempt, response.headers.get("retry-after"))
                        self._sleep(self.throttle.cooldown_429)
                    continue
                if response.status_code in RETRY_STATUSES and attempt + 1 < attempts:
                    last = f"HTTP {response.status_code}"
                    state.timeouts_in_a_row = 0
                    self._change_gap(host, state, self.throttle.slowdown_error, last)
                    self._backoff(attempt, response.headers.get("retry-after"))
                    continue
                self._on_success(host, state, latency)
                return response
        raise IngestHTTPError(url, attempts, last)
