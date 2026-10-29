"""`fs-export`: build and publish a data build, roll back, or list what is published.

    fs-export build --engine duckdb --store local --out web/public/data
    fs-export build --engine databricks --store r2
    fs-export build --engine databricks --store r2 --stage   # upload only; prints "staged <id>"
    fs-export promote --store r2 --build-id BUILD_ID          # record it and flip latest.json
    fs-export rollback --store r2 [--to BUILD_ID]
    fs-export list --store r2

The R2 store reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; the Databricks source
reads DATABRICKS_ORIGIN, DATABRICKS_TOKEN and DATABRICKS_WAREHOUSE_ID. Exit status 1 on any
failure, so the workflow step fails and the previous build keeps serving.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

from export import build as build_mod
from export.source import DatabricksSource, DuckDBSource, GoldSource
from export.store import LocalStore, R2Store, Store


def _git_sha() -> str:
    env_sha = os.environ.get("GITHUB_SHA")
    if env_sha:
        return env_sha
    proc = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return proc.stdout.strip() or "local"


def make_store(kind: str, out: Path) -> Store:
    if kind == "local":
        return LocalStore(out)
    return R2Store(
        os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""),
        os.environ.get("CLOUDFLARE_API_TOKEN", ""),
        os.environ.get("R2_BUCKET", "fantasyscout-data"),
    )


def make_source(engine: str, duckdb_path: Path) -> GoldSource:
    if engine == "duckdb":
        return DuckDBSource(duckdb_path)
    return DatabricksSource(
        os.environ.get("DATABRICKS_ORIGIN", ""),
        os.environ.get("DATABRICKS_TOKEN", ""),
        os.environ.get("DATABRICKS_WAREHOUSE_ID", ""),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fs-export", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def add_store(p: argparse.ArgumentParser) -> None:
        p.add_argument("--store", choices=("local", "r2"), default="local")
        p.add_argument("--out", type=Path, default=Path("web/public/data"), help="local store root")

    p_build = sub.add_parser("build", help="assemble and publish a build")
    add_store(p_build)
    p_build.add_argument("--engine", choices=("duckdb", "databricks"), required=True)
    p_build.add_argument("--duckdb", type=Path, default=Path("dbt/fantasyscout.duckdb"))
    p_build.add_argument("--build-id", default=None, help="override the generated build id")
    p_build.add_argument("--keep", type=int, default=7, help="builds kept for rollback")
    p_build.add_argument(
        "--skip",
        default="",
        help="comma-separated table names to leave out (for example fct_event)",
    )
    p_build.add_argument(
        "--stage",
        action="store_true",
        help="upload the build without pointing latest.json at it (promote it afterwards)",
    )

    p_promote = sub.add_parser("promote", help="record a staged build and point latest at it")
    add_store(p_promote)
    p_promote.add_argument("--build-id", required=True)
    p_promote.add_argument("--keep", type=int, default=7, help="builds kept for rollback")

    p_roll = sub.add_parser("rollback", help="point latest at an earlier build")
    add_store(p_roll)
    p_roll.add_argument("--to", default=None, help="build id (default: the previous build)")

    p_list = sub.add_parser("list", help="show latest and the builds kept")
    add_store(p_list)

    p_nb = sub.add_parser(
        "publish-files", help="put extra files (notebooks, the Tableau extract) under a build"
    )
    add_store(p_nb)
    p_nb.add_argument("files", nargs="+", type=Path, help="files to publish")
    p_nb.add_argument("--subdir", required=True, help="folder under the build, e.g. notebooks")
    p_nb.add_argument("--build-id", default=None, help="target build (default: latest)")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    args = build_parser().parse_args(argv)
    try:
        store = make_store(args.store, args.out)
        if args.command == "build":
            source = make_source(args.engine, args.duckdb)
            try:
                print(f"assembling build from {args.engine}")
                build = build_mod.assemble(
                    source,
                    engine=args.engine,
                    git_sha=_git_sha(),
                    build_id=args.build_id,
                    skip_tables=frozenset(s for s in args.skip.split(",") if s),
                )
            finally:
                source.close()
            print(f"publishing {build.build_id} ({len(build.files)} files) to {args.store}")
            if args.stage:
                build_mod.stage(store, build)
                print(f"staged {build.build_id}")
            else:
                latest = build_mod.publish(store, build, keep=args.keep)
                print(f"published {latest['build_id']}; data as of {latest['data_as_of']}")
        elif args.command == "promote":
            latest = build_mod.promote(store, args.build_id, keep=args.keep)
            print(f"promoted {args.build_id}; latest is {latest['build_id']}")
        elif args.command == "rollback":
            pointer = build_mod.rollback(store, to=args.to)
            print(f"latest is now {pointer['build_id']}")
        elif args.command == "publish-files":
            keys = build_mod.publish_files(
                store, args.files, subdir=args.subdir, build_id=args.build_id
            )
            for key in keys:
                print(f"  {key}")
            print(f"published {len(keys)} file(s) under {args.subdir}")
        else:
            latest, builds = build_mod.list_builds(store)
            print(f"latest: {latest.get('build_id', 'none')}")
            for entry in builds:
                print(f"  {entry['build_id']}  {entry['created_at']}  {entry.get('engine', '')}")
        return 0
    except Exception as exc:
        print(f"export failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
