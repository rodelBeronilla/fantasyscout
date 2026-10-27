"""``fs-ingest`` command line entry point.

Phase 0 ships the flag surface only; the stats API and ESPN ingestors arrive in phase 1.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import date

SOURCES = ("stats", "espn")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fs-ingest", description="Land raw basketball data.")
    parser.add_argument("source", choices=SOURCES, help="which provider to pull from")
    parser.add_argument("--league", choices=("wnba", "nba"), default="wnba")
    parser.add_argument("--season", help="season label, e.g. 2026 or 2025-26")
    parser.add_argument("--since", type=date.fromisoformat, help="only games on or after this date")
    parser.add_argument(
        "--full-refresh", action="store_true", help="ignore landed hashes and re-fetch everything"
    )
    parser.add_argument("--dry-run", action="store_true", help="plan requests without sending any")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print(
        f"fs-ingest: source={args.source} league={args.league} season={args.season} "
        f"since={args.since} full_refresh={args.full_refresh} dry_run={args.dry_run}",
        file=sys.stderr,
    )
    print("ingestors are not implemented yet (phase 1); nothing was fetched.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
