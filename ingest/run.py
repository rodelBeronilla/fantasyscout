"""Shared run bookkeeping for every ingestor: what landed, what was skipped, what failed."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime

from ingest.landing import League
from ingest.store import LandResult


@dataclass
class FetchFailure:
    endpoint: str
    key: str
    reason: str


class MissingPayloadError(Exception):
    """The source has no payload for this key (HTTP 404); not a failure of ours."""


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

    def record(self, result: LandResult | None) -> None:
        if result is None or result.outcome == "skipped":
            self.skipped += 1
        elif result.outcome == "landed":
            self.landed += 1
        else:
            self.unchanged += 1

    def fail(self, endpoint: str, key: str, exc: BaseException) -> None:
        self.failures.append(FetchFailure(endpoint, key, f"{type(exc).__name__}: {exc}"))

    def miss(self, endpoint: str, key: str, reason: str) -> None:
        self.missing.append(FetchFailure(endpoint, key, reason))

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
