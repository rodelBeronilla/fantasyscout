"""Throttled, retrying HTTP client shared by every ingestor.

Implements the rules in SPEC.md ("Rules for every ingestor"): one request at a time per
host, a randomized 1.5-3 s gap between requests to the same host, exponential backoff
with jitter on transport errors and retryable statuses, at most five retries, and the
browser-like headers the league stats API expects. `Retry-After` is honoured when present.
"""

from __future__ import annotations

import contextlib
import random
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
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
    """Pacing and retry policy. The defaults are the spec's."""

    min_delay: float = 1.5
    max_delay: float = 3.0
    max_retries: int = 5
    backoff_base: float = 1.0
    backoff_cap: float = 60.0
    timeout: float = 30.0


class IngestHTTPError(Exception):
    """Raised when a request still fails after every retry."""

    def __init__(self, url: str, attempts: int, last: str) -> None:
        super().__init__(f"{url}: gave up after {attempts} attempts ({last})")
        self.url = url
        self.attempts = attempts
        self.last = last


class ThrottledClient:
    """Synchronous client that paces requests per host and retries politely.

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
    ) -> None:
        self.throttle = throttle or Throttle()
        self._client = httpx.Client(
            timeout=self.throttle.timeout,
            headers=dict(headers or {}),
            transport=transport,
            follow_redirects=False,
        )
        self._sleep = sleep
        self._clock = clock
        self._rng = rng or random.Random()
        self._last_request: dict[str, float] = {}
        self._host_locks: dict[str, threading.Lock] = {}
        self._registry_lock = threading.Lock()

    def __enter__(self) -> ThrottledClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _lock_for(self, host: str) -> threading.Lock:
        with self._registry_lock:
            return self._host_locks.setdefault(host, threading.Lock())

    def _pace(self, host: str) -> None:
        """Wait until the randomized gap since the last request to this host has passed."""
        last = self._last_request.get(host)
        if last is not None:
            gap = self._rng.uniform(self.throttle.min_delay, self.throttle.max_delay)
            wait = last + gap - self._clock()
            if wait > 0:
                self._sleep(wait)
        self._last_request[host] = self._clock()

    def _backoff(self, attempt: int, retry_after: str | None) -> None:
        delay = min(self.throttle.backoff_cap, self.throttle.backoff_base * 2**attempt)
        delay += self._rng.uniform(0, 1)
        if retry_after is not None:
            with contextlib.suppress(ValueError):
                delay = max(delay, float(retry_after))
        self._sleep(delay)

    def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        """GET with pacing and retries. Returns any non-retryable response, even 4xx."""
        host = httpx.URL(url).host
        attempts = self.throttle.max_retries + 1
        last = "no attempt made"
        with self._lock_for(host):
            for attempt in range(attempts):
                self._pace(host)
                try:
                    response = self._client.get(url, params=params, headers=headers)
                except httpx.TransportError as exc:
                    last = f"{type(exc).__name__}: {exc}"
                    if attempt + 1 < attempts:
                        self._backoff(attempt, None)
                    continue
                if response.status_code in RETRY_STATUSES and attempt + 1 < attempts:
                    last = f"HTTP {response.status_code}"
                    self._backoff(attempt, response.headers.get("retry-after"))
                    continue
                return response
        raise IngestHTTPError(url, attempts, last)
