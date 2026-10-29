"""Reachability probe for every source the ingestors depend on.

The league stats API is reported to block some cloud and CI address ranges, so before
deciding where ingestion runs (ADR 0002) this probe is executed from a GitHub-hosted
runner and from a personal machine. It reports; it never fails the process.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, field

import httpx

from ingest.http import Throttle, ThrottledClient, stats_headers
from ingest.store import workspace_origin

__all__ = [
    "DEFAULT_TARGETS",
    "ProbeResult",
    "Target",
    "databricks_target",
    "run_probe",
    "to_json",
    "to_markdown",
    "workspace_origin",
]

_STATS_PARAMS = {
    "Counter": "1000",
    "DateFrom": "",
    "DateTo": "",
    "Direction": "DESC",
    "PlayerOrTeam": "T",
    "SeasonType": "Regular Season",
    "Sorter": "DATE",
}


@dataclass(frozen=True)
class Target:
    name: str
    url: str
    expect: str
    params: Mapping[str, str] = field(default_factory=dict)
    headers: Mapping[str, str] = field(default_factory=dict)
    # False for a page or a file: then ``expect`` must appear in the first bytes of the body.
    json: bool = True


@dataclass(frozen=True)
class ProbeResult:
    name: str
    url: str
    ok: bool
    status: int | None
    ms: int
    bytes: int
    detail: str


REPORT_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0"}

DEFAULT_TARGETS: tuple[Target, ...] = (
    Target(
        name="stats-wnba",
        url="https://stats.wnba.com/stats/leaguegamelog",
        params={**_STATS_PARAMS, "LeagueID": "10", "Season": "2026"},
        headers=stats_headers("wnba"),
        expect="resultSets",
    ),
    Target(
        name="stats-nba",
        url="https://stats.nba.com/stats/leaguegamelog",
        params={**_STATS_PARAMS, "LeagueID": "00", "Season": "2025-26"},
        headers=stats_headers("nba"),
        expect="resultSets",
    ),
    Target(
        name="espn-wnba",
        url="https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard",
        expect="events",
    ),
    Target(
        name="espn-nba",
        url="https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
        expect="events",
    ),
    # The leagues' official injury reports: the NBA's index page and a WNBA report PDF.
    Target(
        name="injury-report-nba-index",
        url="https://official.nba.com/nba-injury-report-2026-27-season/",
        expect="Injury-Report_",
        headers=REPORT_HEADERS,
        json=False,
    ),
    Target(
        name="injury-report-wnba-pdf",
        url="https://ak-static.cms.nba.com/referee/wnba_injury/Injury-Report_2026-07-27_08_00PM.pdf",
        expect="%PDF",
        headers=REPORT_HEADERS,
        json=False,
    ),
)


def databricks_target(env: Mapping[str, str] = os.environ) -> Target | None:
    """A Unity Catalog call that proves host and token work. None when they are not set."""
    host = workspace_origin(env.get("DATABRICKS_HOST", ""))
    token = env.get("DATABRICKS_TOKEN", "")
    if not host or not token:
        return None
    return Target(
        name="databricks",
        url=f"{host}/api/2.1/unity-catalog/catalogs",
        headers={"Authorization": f"Bearer {token}"},
        expect="catalogs",
    )


def _check(target: Target, response: httpx.Response) -> tuple[bool, str]:
    if 300 <= response.status_code < 400:
        location = httpx.URL(response.headers.get("location", ""))
        where = f"{location.host}{location.path}" if location.host else "(no Location)"
        return False, f"HTTP {response.status_code} redirect to {where}"
    if response.status_code != 200:
        return False, f"HTTP {response.status_code}"
    if not target.json:
        found = target.expect.encode() in response.content[:200_000]
        return found, f"body {'with' if found else 'without'} '{target.expect}'"
    try:
        payload = response.json()
    except ValueError:
        return False, "not JSON"
    if not isinstance(payload, dict) or target.expect not in payload:
        return False, f"JSON without '{target.expect}'"
    return True, f"JSON with '{target.expect}'"


def run_probe(
    targets: Iterable[Target],
    *,
    client: ThrottledClient | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> list[ProbeResult]:
    """Hit every target once (one retry at most) and describe what came back."""
    owned = client is None
    client = client or ThrottledClient(Throttle(max_retries=1))
    results: list[ProbeResult] = []
    try:
        for target in targets:
            started = clock()
            try:
                response = client.get(target.url, params=target.params, headers=target.headers)
            except Exception as exc:  # a probe reports, it never raises
                results.append(
                    ProbeResult(
                        name=target.name,
                        url=target.url,
                        ok=False,
                        status=None,
                        ms=int((clock() - started) * 1000),
                        bytes=0,
                        detail=f"{type(exc).__name__}: {exc}",
                    )
                )
                continue
            ok, detail = _check(target, response)
            results.append(
                ProbeResult(
                    name=target.name,
                    url=target.url,
                    ok=ok,
                    status=response.status_code,
                    ms=int((clock() - started) * 1000),
                    bytes=len(response.content),
                    detail=detail,
                )
            )
    finally:
        if owned:
            client.close()
    return results


def to_json(results: Iterable[ProbeResult]) -> str:
    return json.dumps([asdict(r) for r in results], indent=2)


def to_markdown(results: Iterable[ProbeResult]) -> str:
    lines = ["| Source | Reachable | Status | Time | Detail |", "| --- | --- | --- | --- | --- |"]
    for r in results:
        status = "-" if r.status is None else str(r.status)
        lines.append(
            f"| {r.name} | {'yes' if r.ok else 'no'} | {status} | {r.ms} ms | {r.detail} |"
        )
    return "\n".join(lines)
