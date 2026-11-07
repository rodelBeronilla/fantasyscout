"""``fs-ingest`` command line entry point.

fs-ingest probe                  reachability of every source from this machine
fs-ingest land <source> ...      fetch and land raw payloads for one league-season
fs-ingest import FILE... ...      land tables the owner saved while browsing (tools/save-tables)
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from ingest import land as land_mod
from ingest import manual as manual_mod
from ingest import probe as probe_mod
from ingest.store import Scope, VolumeBackend, reindex

SOURCES = ("stats", "espn", "reports", "bref")
FAILURE_EXIT = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fs-ingest", description="Land raw basketball data.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_probe = sub.add_parser("probe", help="check that every source answers from here")
    p_probe.add_argument("--out", type=Path, help="write the JSON report to this file")
    p_probe.add_argument(
        "--markdown", action="store_true", help="print a Markdown table instead of JSON"
    )

    p_dirs = sub.add_parser(
        "ensure-dirs", help="create every known landing directory (volume or local)"
    )
    p_dirs.add_argument("--backend", choices=("local", "volume"), default="local")
    p_dirs.add_argument("--root", type=Path, default=Path("."), help="root for the local backend")

    p_reindex = sub.add_parser(
        "reindex", help="rebuild one scope's _index.json from the sidecars next to its payloads"
    )
    p_reindex.add_argument("--source", required=True, help="stats, espn, league, odds_api, ...")
    p_reindex.add_argument(
        "--endpoint", required=True, help="the endpoint folder, e.g. leaguegamelog"
    )
    p_reindex.add_argument("--league", choices=("wnba", "nba"), required=True)
    p_reindex.add_argument(
        "--season", required=True, help="the season folder, e.g. 2026 or 2026-27"
    )
    p_reindex.add_argument("--backend", choices=("local", "volume"), default="local")
    p_reindex.add_argument(
        "--root", type=Path, default=Path("."), help="root for the local backend"
    )
    p_import = sub.add_parser(
        "import", help="land the tables saved with the Save tables bookmarklet (tools/save-tables)"
    )
    p_import.add_argument("files", nargs="+", type=Path, help="the saved JSON files")
    p_import.add_argument(
        "--source", required=True, help="where the pages came from, lower case (spotrac, pst)"
    )
    p_import.add_argument("--league", choices=("wnba", "nba"), required=True)
    p_import.add_argument("--season", required=True, help="the season the pages describe")
    p_import.add_argument("--backend", choices=("local", "volume"), default="local")
    p_import.add_argument("--root", type=Path, default=Path("."), help="root for the local backend")

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
        "--shots",
        choices=("game", "team-season"),
        default="game",
        help="stats API only: shot charts per game (daily) or per team for the season (backfill)",
    )
    p_land.add_argument(
        "--pace",
        choices=("spec", "adaptive"),
        default="spec",
        help=(
            "spec: 1.5-3 s between requests (daily); adaptive: starts there and earns a lower "
            "gap while the host answers cleanly, backs off on any trouble (backfills)"
        ),
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
        "--history",
        action="store_true",
        help=(
            "reports: land the 5 pm official injury report for each day, --since to --until; "
            "espn: land the season's fantasy market once, as its preseason ADP (#786)"
        ),
    )
    p_land.add_argument(
        "--backend",
        choices=("local", "volume"),
        default="local",
        help="local directory (default) or the Unity Catalog volume via DATABRICKS_HOST/TOKEN",
    )
    p_land.add_argument("--root", type=Path, default=Path("."), help="root for the local backend")
    p_land.add_argument(
        "--only",
        action="append",
        metavar="ENDPOINT[:KEY]",
        help="stats and espn: land only this endpoint, or this endpoint and key (repeatable)",
    )
    p_land.add_argument(
        "--resettle-days",
        type=int,
        metavar="N",
        help="stats and espn: fetch the game payloads of the last N days again, settled or not",
    )
    p_land.add_argument(
        "--from-run-log",
        metavar="PATH",
        help="stats and espn: replay the failed and missing keys of this run log (a landing path)",
    )
    return parser


def _run_probe(out: Path | None, markdown: bool) -> int:
    targets = list(probe_mod.DEFAULT_TARGETS)
    databricks = probe_mod.databricks_target()
    r2 = probe_mod.r2_target()
    if r2 is not None:
        targets.append(r2)
    if databricks is not None:
        targets.append(databricks)
    results = probe_mod.run_probe(targets)
    if out is not None:
        out.write_text(probe_mod.to_json(results) + "\n", encoding="utf-8")
    print(probe_mod.to_markdown(results) if markdown else probe_mod.to_json(results))
    if databricks is None:
        print(
            "databricks: skipped (DATABRICKS_HOST and a credential not set)",
            file=sys.stderr,
        )
    return 0


def _run_land(args: argparse.Namespace) -> int:
    opts = land_mod.LandOptions(
        source=args.source,
        league=args.league,
        season=args.season,
        season_type=args.season_type,
        shots=args.shots,
        pace=args.pace,
        since=args.since,
        until=args.until,
        full_refresh=args.full_refresh,
        dry_run=args.dry_run,
        history=args.history,
        backend=args.backend,
        root=args.root,
        only=tuple(args.only or ()),
        from_run_log=args.from_run_log,
        resettle_days=args.resettle_days,
    )
    summary = land_mod.land(opts)
    if summary is None:
        return 0
    return 0 if summary.ok else FAILURE_EXIT


def main(argv: Sequence[str] | None = None) -> int:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    args = build_parser().parse_args(argv)
    if args.command == "probe":
        return _run_probe(args.out, args.markdown)
    if args.command == "reindex":
        backend = land_mod.make_backend(args.backend, args.root)
        scope = Scope(args.source, args.endpoint, args.league, args.season)
        entries = reindex(backend, scope)
        print(f"{scope.index_path()}: {len(entries)} keys from the sidecars")
        return 0
    if args.command == "ensure-dirs":
        backend = land_mod.make_backend(args.backend, args.root)
        if isinstance(backend, VolumeBackend):
            backend.ensure_volume()
        count = land_mod.ensure_landing_dirs(backend)
        print(f"ensured {count} landing directories ({args.backend})")
        return 0
    if args.command == "import":
        backend = land_mod.make_backend(args.backend, args.root)
        result = manual_mod.import_files(
            backend, args.files, source=args.source, league=args.league, season=args.season
        )
        print(f"imported: {result.landed} landed, {result.unchanged} already there")
        for reason in result.rejected:
            print(f"  rejected {reason}")
        return FAILURE_EXIT if result.rejected else 0
    return _run_land(args)


if __name__ == "__main__":
    raise SystemExit(main())
