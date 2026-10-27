"""``fs-ingest land``: run one source for one league-season and record the run.

The run itself never raises on a failed request (SPEC.md: a failed source never fails
the run; it is logged). The process exit code does reflect failures, so a scheduled
workflow can raise an incident while everything that did land stays landed.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Literal

from ingest.espn import EspnIngestor, EspnPlanner
from ingest.http import ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary, describe
from ingest.stats import SeasonType, StatsIngestor, StatsPlanner, season_label
from ingest.store import Backend, Landing, LocalBackend, VolumeBackend

Source = Literal["stats", "espn"]
BackendKind = Literal["local", "volume"]

RUN_LOG_DIR = PurePosixPath("landing/_ops/ingest_log")


@dataclass(frozen=True)
class LandOptions:
    source: Source
    league: League
    season: str | None = None
    season_type: SeasonType = "Regular Season"
    since: date | None = None
    until: date | None = None
    full_refresh: bool = False
    dry_run: bool = False
    backend: BackendKind = "local"
    root: Path = Path(".")
    window_days: int = 7


def default_season(league: League, today: date) -> str:
    """The season in progress or most recently finished.

    The WNBA plays May to October within one calendar year. The NBA season starts in
    October and is labelled by both years.
    """
    if league == "wnba":
        return season_label("wnba", today.year if today.month >= 5 else today.year - 1)
    return season_label("nba", today.year if today.month >= 10 else today.year - 1)


def make_backend(kind: BackendKind, root: Path, env: Mapping[str, str] = os.environ) -> Backend:
    if kind == "local":
        return LocalBackend(root)
    host, token = env.get("DATABRICKS_HOST", ""), env.get("DATABRICKS_TOKEN", "")
    if not host or not token:
        msg = "backend 'volume' needs DATABRICKS_HOST and DATABRICKS_TOKEN in the environment"
        raise SystemExit(msg)
    return VolumeBackend(host, token)


def plan_lines(opts: LandOptions, season: str, since: date, until: date) -> Sequence[str]:
    """What a run would do, for ``--dry-run``. No network."""
    lines = [
        f"{opts.source} {opts.league} {season} ({opts.season_type}), window {since} to {until}, "
        f"backend={opts.backend}, full_refresh={opts.full_refresh}"
    ]
    if opts.source == "stats":
        planner = StatsPlanner(opts.league, season, opts.season_type)
        lines.extend(f"  {r.endpoint} key={r.key}" for r in planner.season_requests())
        lines.append(
            "  then per game in window: "
            + ", ".join(r.endpoint for r in planner.game_requests("<game>"))
        )
        lines.append("  then commonteamroster per team seen in the window")
    else:
        days = (until - since).days + 1
        lines.append(f"  scoreboard for {days} day(s), then summary per completed event")
        lines.append("  then teams, roster per team, injuries")
    return lines


def run_log_path(summary: RunSummary, run_id: str) -> PurePosixPath:
    day = summary.started_at.date().isoformat()
    return RUN_LOG_DIR / day / f"{summary.source}-{summary.league}-{summary.season}-{run_id}.json"


def land(
    opts: LandOptions, *, today: date | None = None, env: Mapping[str, str] = os.environ
) -> RunSummary | None:
    """Run the ingest. Returns the summary, or None for a dry run."""
    today = today or datetime.now(UTC).date()
    season = opts.season or default_season(opts.league, today)
    until = opts.until or today
    since = opts.since or until - timedelta(days=opts.window_days - 1)

    if opts.dry_run:
        for line in plan_lines(opts, season, since, until):
            print(line)
        return None

    backend = make_backend(opts.backend, opts.root, env)
    landing = Landing(backend, ingest_date=today, full_refresh=opts.full_refresh)
    run_id = uuid.uuid4().hex[:12]
    with ThrottledClient() as client:
        if opts.source == "stats":
            summary = StatsIngestor(
                client, landing, StatsPlanner(opts.league, season, opts.season_type)
            ).run(since=since, until=until)
        else:
            summary = EspnIngestor(client, landing, EspnPlanner(opts.league, season)).run(
                since=since, until=until
            )

    record = {
        **summary.to_dict(),
        "run_id": run_id,
        "window": {"since": since.isoformat(), "until": until.isoformat()},
        "full_refresh": opts.full_refresh,
        "backend": opts.backend,
        "finished_at": datetime.now(UTC).isoformat(),
    }
    backend.write_bytes(
        run_log_path(summary, run_id), (json.dumps(record, indent=2) + "\n").encode()
    )
    for line in describe(summary):
        print(line)
    print(f"run {run_id} logged to {run_log_path(summary, run_id)}")
    return summary
