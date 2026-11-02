"""The league-seasons a running Backfill is landing, as dbt vars for the completeness check (#420).

    gh run list -w backfill.yml -L 20 --json status,displayTitle | uv run python -m ops.backfilling

A backfill lands a season over hours, and every build in between used to find its games missing a
box score and block the publish on ``assert_completeness`` until it finished (#25: five blocked
gates). The Backfill workflow names its runs ``Backfill <league> <seasons JSON> (<source>)``; this
reads the runs still queued or in progress from ``gh run list`` on stdin and prints the dbt vars
``{"backfilling": ["nba:2023-24", ...]}``, the league-seasons the check leaves out while they
land. Only a backfill that lands box scores (source ``both`` or ``stats``) counts. Each one is
named in a GitHub notice, so the build log says what was not judged; the first build after the
backfill finishes judges it again.
"""

from __future__ import annotations

import json
import sys
from typing import Any

PREFIX = "Backfill "
RUNNING = {"queued", "in_progress", "waiting", "requested", "pending"}
BOX_SOURCES = {"both", "stats"}


def parse_title(title: str) -> list[str]:
    """``league:season`` for each season a Backfill run's title names, or none for another title."""
    if not title.startswith(PREFIX):
        return []
    league, _, rest = title[len(PREFIX) :].partition(" ")
    seasons_text, source = rest, "both"
    if rest.endswith(")") and " (" in rest:
        seasons_text, _, source = rest[:-1].rpartition(" (")
    if league not in ("wnba", "nba") or source not in BOX_SOURCES:
        return []
    try:
        seasons = json.loads(seasons_text)
    except ValueError:
        return []
    if not isinstance(seasons, list):
        return []
    return [f"{league}:{s}" for s in seasons if isinstance(s, str) and s]


def backfilling(runs: list[dict[str, Any]]) -> list[str]:
    """The league-seasons of every Backfill run that has not finished, each once, sorted."""
    out: set[str] = set()
    for run in runs:
        if str(run.get("status", "")).lower() in RUNNING:
            out.update(parse_title(str(run.get("displayTitle", ""))))
    return sorted(out)


def main() -> int:
    try:
        runs = json.load(sys.stdin)
    except ValueError:
        runs = []
    seasons = backfilling(runs if isinstance(runs, list) else [])
    for s in seasons:
        print(
            f"::notice::assert_completeness leaves out {s} while its backfill runs", file=sys.stderr
        )
    print(json.dumps({"backfilling": seasons}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
