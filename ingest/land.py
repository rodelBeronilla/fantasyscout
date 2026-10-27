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
from ingest.http import Throttle, ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary, describe
from ingest.stats import SeasonType, ShotsScope, StatsIngestor, StatsPlanner, season_label
from ingest.store import Backend, Landing, LocalBackend, VolumeBackend

Source = Literal["stats", "espn"]
BackendKind = Literal["local", "volume"]
Pace = Literal["spec", "adaptive"]

RUN_LOG_DIR = PurePosixPath("landing/_ops/ingest_log")

# Every endpoint a bronze model reads. Databricks read_files fails on a path that does not
# exist yet, so these directories are created before any build and on every ingest run.
ENDPOINT_DIRS: dict[str, tuple[str, ...]] = {
    "stats": (
        "scheduleleaguev2",
        "commonallplayers",
        "leaguegamelog",
        "playergamelogs",
        "boxscoretraditionalv3",
        "boxscoreadvancedv3",
        "playbyplayv3",
        "shotchartdetail",
        "commonteamroster",
    ),
    "espn": ("scoreboard", "summary", "teams", "roster", "injuries"),
}


def landing_dirs() -> list[PurePosixPath]:
    dirs = [RUN_LOG_DIR]
    for source, endpoints in ENDPOINT_DIRS.items():
        dirs.extend(PurePosixPath("landing", source, endpoint) for endpoint in endpoints)
    return dirs


def ensure_landing_dirs(backend: Backend) -> int:
    """Create every known landing directory; returns how many were ensured."""
    dirs = landing_dirs()
    for path in dirs:
        backend.ensure_directory(path)
    return len(dirs)


@dataclass(frozen=True)
class LandOptions:
    source: Source
    league: League
    season: str | None = None
    season_type: SeasonType = "Regular Season"
    shots: ShotsScope = "game"
    pace: Pace = "spec"
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
        f"backend={opts.backend}, full_refresh={opts.full_refresh}, pace={opts.pace}"
    ]
    if opts.source == "stats":
        planner = StatsPlanner(opts.league, season, opts.season_type, opts.shots)
        lines.extend(f"  {r.endpoint} key={r.key}" for r in planner.season_requests())
        if opts.shots == "team-season":
            lines.append("  shotchartdetail once per team for the whole season")
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


def _announce_pace(host: str, gap: float, reason: str) -> None:
    print(f"pace {host}: gap now {gap:.2f}s ({reason})")


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
    if isinstance(backend, VolumeBackend):
        # Fail here, loudly, rather than once per request inside the run.
        created = backend.ensure_volume()
        print("volume: " + ", ".join(f"{k} {v}" for k, v in created.items()))
    ensure_landing_dirs(backend)
    landing = Landing(
        backend,
        ingest_date=today,
        full_refresh=opts.full_refresh,
        workers=4 if isinstance(backend, VolumeBackend) else 1,
    )
    run_id = uuid.uuid4().hex[:12]
    throttle = Throttle.adaptive() if opts.pace == "adaptive" else Throttle.spec()
    with ThrottledClient(throttle, on_pace_change=_announce_pace) as client:
        if opts.source == "stats":
            summary = StatsIngestor(
                client, landing, StatsPlanner(opts.league, season, opts.season_type, opts.shots)
            ).run(since=since, until=until)
        else:
            summary = EspnIngestor(client, landing, EspnPlanner(opts.league, season)).run(
                since=since, until=until
            )
    landing.close()

    record = {
        **summary.to_dict(),
        "run_id": run_id,
        "window": {"since": since.isoformat(), "until": until.isoformat()},
        "full_refresh": opts.full_refresh,
        "backend": opts.backend,
        "finished_at": datetime.now(UTC).isoformat(),
    }
    try:
        backend.write_bytes(
            run_log_path(summary, run_id), (json.dumps(record, indent=2) + "\n").encode()
        )
        logged = f"run {run_id} logged to {run_log_path(summary, run_id)}"
    except Exception as exc:  # the summary must still reach the operator
        summary.fail("_ops", "ingest_log", exc)
        logged = f"run {run_id}: could not write the run log ({type(exc).__name__}: {exc})"
    for line in describe(summary):
        print(line)
    print(logged)
    return summary
