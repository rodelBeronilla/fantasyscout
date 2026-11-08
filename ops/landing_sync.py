"""Mirror the landed payloads of some league-seasons to a local directory (#769).

    uv run python -m ops.landing_sync --league nba --season 2022-23 --season 2023-24 --out landing

A point-in-time build runs on DuckDB only (ADR 0018), so the walk-forward harness builds from a
local copy of the landing volume. A checkpoint needs its season and the two before it (the
projection's three seasons), never the whole volume: this copies every payload under
``landing/<source>/<endpoint>/<league>/<season>/`` for the seasons named, skipping files already
present (a landed path never changes; a re-landing gets a new ingest date) and the ingest's
own ``_index.json`` bookkeeping. It reads the volume through the Files API, so it uses no SQL
warehouse time.

Credentials come from the environment, as the ingest's do: ``DATABRICKS_HOST`` with either the
service principal's ``DATABRICKS_CLIENT_ID`` and ``DATABRICKS_CLIENT_SECRET`` or a
``DATABRICKS_TOKEN``.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Protocol

from ingest.store import VolumeBackend, credentials_from_env

LANDING = PurePosixPath("landing")
SKIPPED_NAMES = frozenset({"_index.json"})
# Rounds a failed read is retried in, and the first pause between them (doubling): #806.
ROUNDS = 5
FIRST_PAUSE = 30.0


class Source(Protocol):
    """What the sync reads: a shallow and a recursive listing, and a file's bytes."""

    def list_directory(self, directory: PurePosixPath) -> list[tuple[PurePosixPath, bool]]: ...

    def list_files(self, directory: PurePosixPath) -> list[PurePosixPath]: ...

    def read_bytes(self, path: PurePosixPath) -> bytes | None: ...


@dataclass(frozen=True)
class SyncResult:
    copied: int
    present: int
    missing: int
    bytes_copied: int
    failed: list[str] = field(default_factory=list)


def _subdirs(source: Source, directory: PurePosixPath) -> list[PurePosixPath]:
    return [
        p for p, is_dir in source.list_directory(directory) if is_dir and not p.name.startswith("_")
    ]


def plan(source: Source, leagues: Iterable[str], seasons: Iterable[str]) -> list[PurePosixPath]:
    """Every payload under landing/<source>/<endpoint>/<league>/<season>/ for the given ones."""
    wanted = [(league, season) for league in leagues for season in seasons]
    out: list[PurePosixPath] = []
    for feed in _subdirs(source, LANDING):
        for endpoint in _subdirs(source, feed):
            for league, season in wanted:
                out.extend(
                    f
                    for f in source.list_files(endpoint / league / season)
                    if f.name not in SKIPPED_NAMES
                )
    return sorted(out)


def sync(
    source: Source,
    out: Path,
    files: Sequence[PurePosixPath],
    *,
    workers: int = 8,
    rounds: int = ROUNDS,
    sleep: Callable[[float], None] = time.sleep,
) -> SyncResult:
    """Copy the files not yet under ``out``; a file the source no longer has is counted missing.

    A read that fails (the Files API answers 429 when several mirrors run at once, #806) does not
    end the sync: the failed files are tried again in later rounds, after a pause that doubles
    each round, and only those still failing after the last round are reported.
    """
    todo = [f for f in files if not out.joinpath(*f.parts).exists()]

    def copy(path: PurePosixPath) -> int | Exception | None:
        try:
            body = source.read_bytes(path)
        except Exception as exc:  # retried in the next round
            return exc
        if body is None:
            return None
        target = out.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".part")
        partial.write_bytes(body)
        partial.replace(target)  # a run killed mid-copy leaves no half-written payload
        return len(body)

    copied: list[int] = []
    missing = 0
    pending = list(todo)
    errors: list[str] = []
    for round_no in range(max(1, rounds)):
        if round_no:
            sleep(FIRST_PAUSE * 2 ** (round_no - 1))
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            results = list(pool.map(copy, pending))
        retry: list[PurePosixPath] = []
        errors = []
        for path, result in zip(pending, results, strict=True):
            if isinstance(result, Exception):
                retry.append(path)
                errors.append(f"{path}: {result}")
            elif result is None:
                missing += 1
            else:
                copied.append(result)
        pending = retry
        if not pending:
            break
    return SyncResult(
        copied=len(copied),
        present=len(files) - len(todo),
        missing=missing,
        bytes_copied=sum(copied),
        failed=errors,
    )


def _volume_from_env(env: dict[str, str]) -> VolumeBackend:
    host = env.get("DATABRICKS_HOST", "")
    auth = credentials_from_env(env)
    token = env.get("DATABRICKS_TOKEN", "")
    if not host or (auth is None and not token):
        msg = "set DATABRICKS_HOST and either DATABRICKS_CLIENT_ID/SECRET or DATABRICKS_TOKEN"
        raise SystemExit(msg)
    return VolumeBackend(host, token, auth=auth)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--league", action="append", required=True, choices=["nba", "wnba"])
    parser.add_argument("--season", action="append", required=True)
    parser.add_argument("--out", type=Path, default=Path("landing_mirror"))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args(argv)
    volume = _volume_from_env(dict(os.environ))
    try:
        files = plan(volume, args.league, args.season)
        result = sync(volume, args.out, files, workers=args.workers)
    finally:
        volume.close()
    print(
        f"{len(files)} payloads for {', '.join(args.league)} {', '.join(args.season)}: "
        f"{result.copied} copied ({result.bytes_copied / 1e6:.1f} MB), {result.present} already "
        f"present, {result.missing} gone from the volume, {len(result.failed)} still failing"
    )
    for line in result.failed[:20]:
        print(f"  {line}", file=sys.stderr)
    return 1 if result.missing or result.failed else 0


if __name__ == "__main__":
    sys.exit(main())
