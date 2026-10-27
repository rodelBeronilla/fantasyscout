"""``fs-ingest`` command line entry point.

fs-ingest probe                  reachability of every source from this machine
fs-ingest land <source> ...      fetch and land raw payloads for one league-season
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from ingest import land as land_mod
from ingest import probe as probe_mod

SOURCES = ("stats", "espn")
FAILURE_EXIT = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fs-ingest", description="Land raw basketball data.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_probe = sub.add_parser("probe", help="check that every source answers from here")
    p_probe.add_argument("--out", type=Path, help="write the JSON report to this file")
    p_probe.add_argument(
        "--markdown", action="store_true", help="print a Markdown table instead of JSON"
    )

    p_land = sub.add_parser("land", help="fetch and land raw payloads")
    p_land.add_argument("source", choices=SOURCES, help="which provider to pull from")
    p_land.add_argument("--league", choices=("wnba", "nba"), default="wnba")
    p_land.add_argument("--season", help="season label, e.g. 2026 or 2025-26 (default: current)")
    p_land.add_argument(
        "--season-type",
        choices=("Regular Season", "Playoffs"),
        default="Regular Season",
        help="stats API only",
    )
    p_land.add_argument(
        "--since", type=date.fromisoformat, help="first game date (default: 6 days before --until)"
    )
    p_land.add_argument("--until", type=date.fromisoformat, help="last game date (default: today)")
    p_land.add_argument(
        "--full-refresh", action="store_true", help="ignore landed hashes and re-fetch everything"
    )
    p_land.add_argument(
        "--dry-run", action="store_true", help="print the plan without sending any request"
    )
    p_land.add_argument(
        "--backend",
        choices=("local", "volume"),
        default="local",
        help="local directory (default) or the Unity Catalog volume via DATABRICKS_HOST/TOKEN",
    )
    p_land.add_argument("--root", type=Path, default=Path("."), help="root for the local backend")
    return parser


def _run_probe(out: Path | None, markdown: bool) -> int:
    targets = list(probe_mod.DEFAULT_TARGETS)
    databricks = probe_mod.databricks_target()
    if databricks is not None:
        targets.append(databricks)
    results = probe_mod.run_probe(targets)
    if out is not None:
        out.write_text(probe_mod.to_json(results) + "\n", encoding="utf-8")
    print(probe_mod.to_markdown(results) if markdown else probe_mod.to_json(results))
    if databricks is None:
        print("databricks: skipped (DATABRICKS_HOST / DATABRICKS_TOKEN not set)", file=sys.stderr)
    return 0


def _run_land(args: argparse.Namespace) -> int:
    opts = land_mod.LandOptions(
        source=args.source,
        league=args.league,
        season=args.season,
        season_type=args.season_type,
        since=args.since,
        until=args.until,
        full_refresh=args.full_refresh,
        dry_run=args.dry_run,
        backend=args.backend,
        root=args.root,
    )
    summary = land_mod.land(opts)
    if summary is None:
        return 0
    return 0 if summary.ok else FAILURE_EXIT


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "probe":
        return _run_probe(args.out, args.markdown)
    return _run_land(args)


if __name__ == "__main__":
    raise SystemExit(main())
