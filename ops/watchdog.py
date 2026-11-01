"""Is the live site serving a build that is recent enough?

    uv run python -m ops.watchdog --site https://fantasyscout.beronilla.rodeo

Reads the published pointer (`/data/latest.json`) and the build's `health.json`, and compares
the build's age with the publish SLA: while a league is playing, a new build is expected at
least every IN_SEASON_HOURS; out of season every OFF_SEASON_HOURS. Exit status 0 when the live
build is inside the SLA, 2 when it is stale or the site does not answer.

This is the one check that runs outside the pipeline, on a GitHub-hosted runner on its own
schedule. Every other alert is a step of the pipeline that failed, so a pipeline that never
starts (a home runner offline, a cron GitHub stopped firing, a build cancelled before its
report step) raises nothing; this does.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

# Builds run after the morning and evening ingests; one missed build still fits inside 30 hours.
IN_SEASON_HOURS = 30
# Out of season the pipeline still runs daily; a quiet week is tolerated, a quiet month is not.
OFF_SEASON_HOURS = 72


@dataclass(frozen=True)
class Verdict:
    stale: bool
    line: str


def decide(
    latest: dict[str, object] | None,
    health: dict[str, object] | None,
    now: datetime,
    in_season_hours: int = IN_SEASON_HOURS,
    off_season_hours: int = OFF_SEASON_HOURS,
) -> Verdict:
    """Whether the live build is older than the SLA allows, and a line saying so."""
    if not latest or not isinstance(latest.get("created_at"), str):
        return Verdict(True, "stale: no build pointer published (latest.json missing or malformed)")
    created = datetime.fromisoformat(str(latest["created_at"]))
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    age_hours = (now - created).total_seconds() / 3600
    feeds = health.get("feeds") if health else None
    leagues = sorted(
        {
            str(f.get("league"))
            for f in (feeds if isinstance(feeds, list) else [])
            if isinstance(f, dict) and f.get("in_season") is True
        }
    )
    limit = in_season_hours if leagues else off_season_hours
    season = f"in season ({', '.join(leagues)})" if leagues else "off season"
    detail = (
        f"live build {latest.get('build_id')} created {created.isoformat()} "
        f"is {age_hours:.1f} h old; {season}, limit {limit} h"
    )
    if age_hours > limit:
        return Verdict(True, f"stale: {detail}")
    return Verdict(False, f"fresh: {detail}")


def fetch_json(client: httpx.Client, url: str) -> dict[str, object] | None:
    try:
        response = client.get(url)
    except httpx.HTTPError as exc:
        print(f"{url}: {exc}")
        return None
    if response.status_code != 200:
        print(f"{url}: HTTP {response.status_code}")
        return None
    body = response.json()
    return body if isinstance(body, dict) else None


def check(site: str, now: datetime | None = None) -> Verdict:
    base = site.rstrip("/")
    with httpx.Client(timeout=30, headers={"cache-control": "no-cache"}) as client:
        latest = fetch_json(client, f"{base}/data/latest.json")
        health = None
        if latest and isinstance(latest.get("build_id"), str):
            health = fetch_json(client, f"{base}/data/builds/{latest['build_id']}/health.json")
    return decide(latest, health, now or datetime.now(UTC))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--site", required=True, help="the site's origin, e.g. https://example.org")
    args = parser.parse_args(argv)
    verdict = check(args.site)
    print(verdict.line)
    return 2 if verdict.stale else 0


if __name__ == "__main__":
    sys.exit(main())
