"""Shared run bookkeeping for every ingestor: what landed, what was skipped, what failed."""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

from ingest.landing import League
from ingest.store import LandResult


@dataclass
class FetchFailure:
    endpoint: str
    key: str
    reason: str


class MissingPayloadError(Exception):
    """The source has no payload for this key (HTTP 404); not a failure of ours."""


@dataclass(frozen=True)
class Only:
    """A replay's filter: the endpoints, or endpoint:key pairs, a run is limited to.

    The requests a run plans from (the game log, a day's scoreboard) are still made; everything
    else is skipped unless it matches, so a run can redo exactly the keys an earlier run failed.
    """

    endpoints: frozenset[str] = frozenset()
    keys: frozenset[tuple[str, str]] = frozenset()

    @classmethod
    def parse(cls, specs: Iterable[str]) -> Only:
        endpoints: set[str] = set()
        keys: set[tuple[str, str]] = set()
        for spec in specs:
            spec = spec.strip()
            if not spec:
                continue
            endpoint, sep, key = spec.partition(":")
            if sep:
                keys.add((endpoint, key))
            else:
                endpoints.add(endpoint)
        return cls(frozenset(endpoints), frozenset(keys))

    def __bool__(self) -> bool:
        return bool(self.endpoints or self.keys)

    def allows(self, endpoint: str, key: str) -> bool:
        return endpoint in self.endpoints or (endpoint, key) in self.keys

    def merged(self, other: Only) -> Only:
        return Only(self.endpoints | other.endpoints, self.keys | other.keys)

    def specs(self) -> Iterable[str]:
        yield from (f"{e}:{k}" for e, k in sorted(self.keys))
        yield from sorted(self.endpoints)


def only_from_run_log(payload: bytes) -> Only:
    """The failed and missing keys a run log names, as a filter for a replay."""
    record = json.loads(payload)
    specs = [
        f"{item['endpoint']}:{item['key']}"
        for group in ("failures", "missing")
        for item in record.get(group, [])
        if isinstance(item, dict) and "endpoint" in item and "key" in item
    ]
    return Only.parse(specs)


@dataclass
class RunSummary:
    """Counts for one source/league/season run. A failed request never fails the run."""

    source: str
    league: League
    season: str
    started_at: datetime
    landed: int = 0
    unchanged: int = 0
    skipped: int = 0
    games: int = 0
    failures: list[FetchFailure] = field(default_factory=list)
    missing: list[FetchFailure] = field(default_factory=list)
    pacing: dict[str, dict[str, float | int]] = field(default_factory=dict)
    aborted: str | None = None
    # Per endpoint: landed, unchanged, failed and missing counts (a skipped request names none).
    endpoints: dict[str, dict[str, int]] = field(default_factory=dict)

    heartbeat_every: int = 25

    def record(self, result: LandResult | None) -> None:
        if result is None or result.outcome == "skipped":
            self.skipped += 1
        elif result.outcome == "landed":
            self.landed += 1
            self._count(result.endpoint, "landed")
        else:
            self.unchanged += 1
            self._count(result.endpoint, "unchanged")
        self._heartbeat()

    def _count(self, endpoint: str, what: str) -> None:
        if endpoint:
            tally = self.endpoints.setdefault(endpoint, {})
            tally[what] = tally.get(what, 0) + 1

    @property
    def processed(self) -> int:
        return self.landed + self.unchanged + self.skipped + len(self.failures) + len(self.missing)

    def _heartbeat(self) -> None:
        """A flushed progress line every ``heartbeat_every`` requests, for the live job log."""
        if self.heartbeat_every and self.processed % self.heartbeat_every == 0:
            elapsed = (datetime.now(UTC) - self.started_at).total_seconds()
            rate = self.processed / elapsed if elapsed > 0 else 0.0
            print(
                f"progress {self.source} {self.league} {self.season}: {self.processed} requests "
                f"({self.landed} landed, {self.skipped} skipped, {len(self.failures)} failed) "
                f"in {elapsed / 60:.1f} min, {rate * 60:.0f}/min",
                flush=True,
            )

    def fail(self, endpoint: str, key: str, exc: BaseException) -> None:
        self.failures.append(FetchFailure(endpoint, key, f"{type(exc).__name__}: {exc}"))
        self._count(endpoint, "failed")
        self._heartbeat()

    def miss(self, endpoint: str, key: str, reason: str) -> None:
        self.missing.append(FetchFailure(endpoint, key, reason))
        self._count(endpoint, "missing")

    @property
    def ok(self) -> bool:
        return not self.failures and self.aborted is None

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["started_at"] = self.started_at.isoformat()
        return data


def describe(summary: RunSummary, failures_shown: int = 10) -> Sequence[str]:
    lines = [
        f"{summary.source} {summary.league} {summary.season}: {summary.games} games in window, "
        f"{summary.landed} landed, {summary.unchanged} unchanged, {summary.skipped} skipped, "
        f"{len(summary.missing)} missing at source, {len(summary.failures)} failed"
    ]
    lines.extend(
        f"  missing {m.endpoint}/{m.key}: {m.reason}" for m in summary.missing[:failures_shown]
    )
    lines.extend(
        f"  failed {f.endpoint}/{f.key}: {f.reason}" for f in summary.failures[:failures_shown]
    )
    if len(summary.failures) > failures_shown:
        lines.append(f"  ... {len(summary.failures) - failures_shown} more")
    for host, stats in summary.pacing.items():
        lines.append(
            f"  pacing {host}: {stats['requests']} requests, gap {stats['final_gap']}s "
            f"(min {stats['min_gap']}s, max {stats['max_gap']}s), {stats['speedups']} speed-ups, "
            f"{stats['slowdowns']} slow-downs, {stats['rate_limited']} rate-limited"
        )
    if summary.aborted:
        lines.append(f"  ABORTED: {summary.aborted}")
    return lines
