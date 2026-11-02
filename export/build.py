"""Assemble one build from gold, publish it, flip the pointer, keep seven (SPEC.md, "Export step").

Order of publication matters: every file of the build goes up first, then the manifest, then
``builds.json``, and ``latest.json`` is flipped last, so a reader never sees a pointer to a
build that is not complete. A failed export leaves the previous build serving.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc

from export import layout
from export.encode import columns_of, rows_of, sha256, to_json, to_parquet
from export.players import PlayerFiles
from export.source import GoldSource
from export.store import Store, delete_many, put_many

LATEST_KEY = "latest.json"
BUILDS_KEY = "builds.json"
Log = Callable[[str], None]


def new_build_id(git_sha: str, now: datetime | None = None) -> str:
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{git_sha[:7] or 'local'}"


@dataclass
class Build:
    build_id: str
    engine: str
    git_sha: str
    created_at: str
    files: dict[str, bytes] = field(default_factory=dict)  # logical path -> bytes
    manifest: dict[str, Any] = field(default_factory=dict)

    @property
    def prefix(self) -> str:
        return f"builds/{self.build_id}/"

    def key(self, path: str) -> str:
        return self.prefix + path


def _partitions(table: pa.Table) -> list[tuple[str, str, pa.Table]]:
    leagues = pc.unique(table.column("league")).to_pylist()
    seasons = pc.unique(table.column("season")).to_pylist()
    out: list[tuple[str, str, pa.Table]] = []
    for league in sorted(str(x) for x in leagues):
        for season in sorted(str(x) for x in seasons):
            mask = pc.and_(
                pc.equal(table.column("league"), league), pc.equal(table.column("season"), season)
            )
            part = table.filter(mask)
            if part.num_rows:
                out.append((league, season, part))
    return out


def assemble(
    source: GoldSource,
    *,
    engine: str,
    git_sha: str,
    build_id: str | None = None,
    created_at: str | None = None,
    skip_tables: frozenset[str] = frozenset(),
    log: Log = print,
) -> Build:
    """Pull every table once and shape all the files of a build in memory.

    ``created_at`` is normally now; the test fixture pins it so regenerating the fixture changes
    only what the data changed.
    """
    build = Build(
        build_id=build_id or new_build_id(git_sha),
        engine=engine,
        git_sha=git_sha,
        created_at=created_at or datetime.now(UTC).isoformat(timespec="seconds"),
    )
    tables: dict[str, pa.Table] = {}
    manifest_files: dict[str, dict[str, Any]] = {}
    manifest_tables: dict[str, dict[str, Any]] = {}

    def add(path: str, body: bytes, rows: int | None = None) -> None:
        build.files[path] = body
        entry: dict[str, Any] = {"bytes": len(body), "sha256": sha256(body)}
        if rows is not None:
            entry["rows"] = rows
        manifest_files[path] = entry

    for spec in layout.TABLES:
        if spec.name in skip_tables:
            continue
        try:
            table = source.query(spec.sql)
        except Exception as exc:
            if spec in layout.OPS:
                log(f"  {spec.table}: not available ({type(exc).__name__}), skipped")
                continue
            raise
        tables[spec.name] = table
        paths: list[str] = []
        if spec.partition:
            for league, season, part in _partitions(table):
                path = f"{spec.name}/{layout.partition_key(league, season)}.parquet"
                add(path, to_parquet(part), part.num_rows)
                paths.append(path)
        else:
            path = f"{spec.name}.parquet"
            add(path, to_parquet(table), table.num_rows)
            paths.append(path)
            if spec.json:
                path = f"{spec.name}.json"
                add(path, to_json(rows_of(table)), table.num_rows)
                paths.append(path)
        manifest_tables[spec.table] = {"rows": table.num_rows, "files": paths}
        log(f"  {spec.table}: {table.num_rows} rows, {len(paths)} file(s)")

    # Per-league board, streamers and upcoming schedule, compact for the pages.
    for name, sql in layout.PER_LEAGUE_JSON:
        table = source.query(sql)
        for league in layout.LEAGUES:
            part = table.filter(pc.equal(table.column("league"), league))
            rows = rows_of(part, digits=layout.JSON_DIGITS)
            add(f"{name}/{league}.json", to_json(rows), part.num_rows)
            if name in layout.COLUMNAR_JSON:
                add(f"{name}/{league}.columns.json", to_json(columns_of(rows)), part.num_rows)

    # Data Health in one file.
    data_as_of = {
        row["league"]: row["data_as_of"] for row in rows_of(source.query(layout.DATA_AS_OF_SQL))
    }
    gate_rows = rows_of(tables["publish_gate"]) if "publish_gate" in tables else []
    checks = (
        rows_of(source.query(layout.LATEST_CHECKS_SQL))
        if "test_results" in tables and "publish_gate" in tables
        else []
    )
    health = {
        "build_id": build.build_id,
        "created_at": build.created_at,
        "engine": engine,
        "git_sha": git_sha,
        "data_as_of": data_as_of,
        "gate": gate_rows[0] if gate_rows else None,
        "gate_history": gate_rows[:50],
        "checks": checks,
        "check_counts": {
            status: sum(1 for c in checks if c["status"] == status)
            for status in ("pass", "warn", "fail", "error")
        },
        "ingest_runs": rows_of(tables["ingest_log"])[:100] if "ingest_log" in tables else [],
        "fetch_failures": rows_of(tables["fetch_failures"])[:100]
        if "fetch_failures" in tables
        else [],
        "reconciliation": rows_of(tables["reconciliation_summary"])
        if "reconciliation_summary" in tables
        else [],
        "row_counts": {name: entry["rows"] for name, entry in manifest_tables.items()},
        "feeds": rows_of(tables["feed_freshness"]) if "feed_freshness" in tables else [],
        "builds": rows_of(tables["build_log"])[:50] if "build_log" in tables else [],
    }
    add("health.json", to_json(health))

    # Per-player files.
    needed = (
        "dim_player",
        "dim_team",
        "dim_game",
        "fct_player_game",
        "mart_player_rolling",
        "mart_category_zscores",
        "mart_board",
        "fct_shot",
    )
    player_count = 0
    # Optional: a build without it still writes player files, without the injury history.
    optional = ("fct_injury_status", "fct_transaction", "fct_player_news")
    if all(n in tables for n in needed):
        maker = PlayerFiles({n: tables[n] for n in (*needed, *optional) if n in tables})
        try:
            for (league, player_id), payload in maker.build().items():
                build.files[f"players/{league}/{player_id}.json"] = to_json(payload)
                player_count += 1
        finally:
            maker.close()
    log(f"  players: {player_count} files")

    build.manifest = {
        "build_id": build.build_id,
        "created_at": build.created_at,
        "engine": engine,
        "git_sha": git_sha,
        "data_as_of": data_as_of,
        "gate": health["gate"],
        "check_counts": health["check_counts"],
        "tables": manifest_tables,
        "files": manifest_files,
        "players": {"count": player_count, "prefix": "players/"},
    }
    return build


def _read_json(store: Store, key: str) -> Any:
    body = store.get(key)
    return json.loads(body) if body else None


STAGING_KEY = "staging.json"
# A staged build that has not gone live after this long never will (the job that staged it failed
# or was cancelled): the next promotion's prune removes it (#404).
STALE_STAGE_DAYS = 2


def _record_stage(store: Store, build_id: str, *, done: bool) -> None:
    """Add a build to the root staging.json while it is staged, or take it off once it is live."""
    staging: list[dict[str, Any]] = _read_json(store, STAGING_KEY) or []
    staging = [s for s in staging if s.get("build_id") != build_id]
    if not done:
        staging.append(
            {"build_id": build_id, "staged_at": datetime.now(UTC).isoformat(timespec="seconds")}
        )
    store.put(STAGING_KEY, to_json(staging))


def stage(store: Store, build: Build, *, log: Log = print) -> None:
    """Upload a build's files, manifest and key list, without pointing anything at it.

    Readers find a build only through latest.json, so a staged build can be read by its id (the
    notebooks and the Tableau extract do) and completed before it goes live with ``promote``.

    The build is recorded in staging.json and its key list is written before its files, so a job
    cut short during the upload still leaves a record and the list of what to delete; the manifest
    comes last, so a cut-short build is never complete enough to roll back to (#404).
    """
    _record_stage(store, build.build_id, done=False)
    manifest_key = build.key("manifest.json")
    keys = [*sorted(build.key(p) for p in build.files), manifest_key]
    store.put(build.key("keys.txt"), "\n".join(keys).encode("utf-8"))
    items = [(build.key(path), body) for path, body in build.files.items()]
    count = put_many(store, items)
    log(f"  uploaded {count} files")
    store.put(manifest_key, to_json(build.manifest))
    log(f"  staged {build.build_id}")


def promote(
    store: Store, build_id: str, *, keep: int = layout.KEEP_BUILDS, log: Log = print
) -> dict[str, Any]:
    """Record a staged build in builds.json, flip latest.json to it, prune old builds.

    latest.json is written after everything the build carries, so a reader never sees a build
    that is still being completed. Returns the latest pointer.
    """
    manifest_key = f"builds/{build_id}/manifest.json"
    manifest = _read_json(store, manifest_key)
    if not manifest:
        msg = f"build {build_id} is not staged (no {manifest_key})"
        raise RuntimeError(msg)

    builds: list[dict[str, Any]] = _read_json(store, BUILDS_KEY) or []
    builds = [b for b in builds if b["build_id"] != build_id]
    builds.insert(
        0,
        {
            "build_id": build_id,
            "created_at": manifest.get("created_at", ""),
            "engine": manifest.get("engine", ""),
            "git_sha": manifest.get("git_sha", ""),
            "manifest": manifest_key,
            "data_as_of": manifest.get("data_as_of", {}),
        },
    )
    store.put(BUILDS_KEY, to_json(builds))
    _record_stage(store, build_id, done=True)

    current = _read_json(store, LATEST_KEY) or {}
    if current.get("pinned"):
        # A rollback pinned the site: record the new build but leave latest.json alone until
        # someone unpins it (fs-export unpin), so a nightly build cannot undo a rollback.
        log(
            f"  latest.json is pinned to {current.get('build_id')} by a rollback; "
            f"{build_id} is recorded but not live (fs-export unpin to go live)"
        )
        prune(store, keep=keep, log=log)
        return dict(current)

    latest = {
        "build_id": build_id,
        "manifest": manifest_key,
        "created_at": manifest.get("created_at", ""),
        "data_as_of": manifest.get("data_as_of", {}),
    }
    store.put(LATEST_KEY, to_json(latest))
    log(f"  latest.json -> {build_id}")

    prune(store, keep=keep, log=log)
    return latest


def publish(
    store: Store, build: Build, *, keep: int = layout.KEEP_BUILDS, log: Log = print
) -> dict[str, Any]:
    """Stage a build and promote it at once. Returns the latest pointer."""
    stage(store, build, log=log)
    return promote(store, build.build_id, keep=keep, log=log)


def prune(store: Store, *, keep: int = layout.KEEP_BUILDS, log: Log = print) -> list[str]:
    """Delete every build beyond the newest ``keep``, except latest's and the pinned ones.

    A rollback pins its build in builds.json as well as in latest.json, so the pin protects the
    build even if latest.json were to point elsewhere for a moment (the workflows share one
    concurrency group, so they should not, but the two records agree on purpose).
    """
    builds: list[dict[str, Any]] = _read_json(store, BUILDS_KEY) or []
    latest = _read_json(store, LATEST_KEY) or {}
    current = latest.get("build_id")
    kept: list[dict[str, Any]] = []
    dropped: list[str] = []
    for entry in builds:
        if len(kept) < keep or entry["build_id"] == current or entry.get("pinned"):
            kept.append(entry)
        else:
            dropped.append(entry["build_id"])
    for build_id in dropped:
        _delete_build(store, build_id, log=log)
    if dropped:
        store.put(BUILDS_KEY, to_json(kept))
    return dropped + prune_stale_stages(store, log=log)


def _delete_build(store: Store, build_id: str, *, log: Log = print) -> int:
    listing = store.get(f"builds/{build_id}/keys.txt")
    keys = listing.decode("utf-8").splitlines() if listing else []
    keys.append(f"builds/{build_id}/keys.txt")
    delete_many(store, keys)
    log(f"  pruned {build_id} ({len(keys)} files)")
    return len(keys)


def prune_stale_stages(
    store: Store,
    *,
    older_than_days: float = STALE_STAGE_DAYS,
    now: datetime | None = None,
    log: Log = print,
) -> list[str]:
    """Delete the staged builds that never went live and are older than ``older_than_days``."""
    staging: list[dict[str, Any]] = _read_json(store, STAGING_KEY) or []
    if not staging:
        return []
    live = {b["build_id"] for b in (_read_json(store, BUILDS_KEY) or [])}
    now = now or datetime.now(UTC)
    kept: list[dict[str, Any]] = []
    removed: list[str] = []
    for entry in staging:
        build_id = str(entry.get("build_id"))
        try:
            staged_at = datetime.fromisoformat(str(entry.get("staged_at")))
        except ValueError:
            staged_at = now
        if build_id in live:
            continue  # promoted after all: the record is done with
        if (now - staged_at).total_seconds() > older_than_days * 86400:
            _delete_build(store, build_id, log=log)
            removed.append(build_id)
        else:
            kept.append(entry)
    store.put(STAGING_KEY, to_json(kept))
    return removed


def orphans(store: Store) -> list[str]:
    """Build folders in the store that neither builds.json, latest.json nor staging.json names.

    A job cut short before #404's records existed left these behind; each costs storage forever.
    """
    named = {b["build_id"] for b in (_read_json(store, BUILDS_KEY) or [])}
    named |= {str(s.get("build_id")) for s in (_read_json(store, STAGING_KEY) or [])}
    latest = (_read_json(store, LATEST_KEY) or {}).get("build_id")
    if latest:
        named.add(str(latest))
    found = {key.split("/")[1] for key in store.list("builds/") if key.count("/") >= 2}
    return sorted(found - named)


def delete_orphan(store: Store, build_id: str, *, log: Log = print) -> int:
    """Delete every object under an orphaned build's folder (its key list may be missing)."""
    keys = store.list(f"builds/{build_id}/")
    delete_many(store, keys)
    log(f"  deleted orphan {build_id} ({len(keys)} files)")
    return len(keys)


def build_is_complete(store: Store, entry: dict[str, Any]) -> bool:
    """Whether a recorded build still has its manifest and key list in the store.

    A prune cancelled midway deletes files first and rewrites builds.json last, so an entry can
    outlive its files; pointing latest.json at such a build would break every page (#405).
    """
    build_id = entry["build_id"]
    manifest = entry.get("manifest") or f"builds/{build_id}/manifest.json"
    return store.get(manifest) is not None and store.get(f"builds/{build_id}/keys.txt") is not None


def _require_complete(store: Store, entry: dict[str, Any]) -> None:
    if not build_is_complete(store, entry):
        msg = (
            f"build {entry['build_id']} is recorded but its manifest or key list is gone "
            "(a prune cancelled midway?); pick another build from `fs-export list`"
        )
        raise RuntimeError(msg)


def rollback(store: Store, *, to: str | None = None, log: Log = print) -> dict[str, Any]:
    """Point latest.json at an earlier build (the previous one by default) and pin it there.

    The pin is recorded in latest.json and on the build's entry in builds.json; nightly builds
    are still recorded while it holds but do not go live until ``unpin``.
    """
    builds: list[dict[str, Any]] = _read_json(store, BUILDS_KEY) or []
    latest = _read_json(store, LATEST_KEY) or {}
    if not builds:
        msg = "no builds recorded; nothing to roll back to"
        raise RuntimeError(msg)
    if to is None:
        ids = [b["build_id"] for b in builds]
        current = latest.get("build_id")
        position = ids.index(current) if current in ids else -1
        if position + 1 >= len(ids):
            msg = f"no build older than {current} to roll back to"
            raise RuntimeError(msg)
        to = ids[position + 1]
    target = next((b for b in builds if b["build_id"] == to), None)
    if target is None:
        msg = f"build {to} is not in builds.json"
        raise RuntimeError(msg)
    _require_complete(store, target)
    pointer = {
        "build_id": target["build_id"],
        "manifest": target["manifest"],
        "created_at": target["created_at"],
        "data_as_of": target.get("data_as_of", {}),
        "rolled_back_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "rolled_back_from": latest.get("build_id"),
        "pinned": True,
    }
    store.put(LATEST_KEY, to_json(pointer))
    for entry in builds:
        entry.pop("pinned", None)
        if entry["build_id"] == target["build_id"]:
            entry["pinned"] = True
    store.put(BUILDS_KEY, to_json(builds))
    log(f"  latest.json -> {target['build_id']} (was {latest.get('build_id')}), pinned")
    return pointer


def unpin(store: Store, *, to: str | None = None, log: Log = print) -> dict[str, Any]:
    """Release a rollback's pin and point latest.json at a build (the newest by default)."""
    builds: list[dict[str, Any]] = _read_json(store, BUILDS_KEY) or []
    if not builds:
        msg = "no builds recorded"
        raise RuntimeError(msg)
    target = builds[0] if to is None else next((b for b in builds if b["build_id"] == to), None)
    if target is None:
        msg = f"build {to} is not in builds.json"
        raise RuntimeError(msg)
    _require_complete(store, target)
    latest = _read_json(store, LATEST_KEY) or {}
    pointer = {
        "build_id": target["build_id"],
        "manifest": target["manifest"],
        "created_at": target["created_at"],
        "data_as_of": target.get("data_as_of", {}),
    }
    store.put(LATEST_KEY, to_json(pointer))
    for entry in builds:
        entry.pop("pinned", None)
    store.put(BUILDS_KEY, to_json(builds))
    log(f"  latest.json -> {target['build_id']} (was {latest.get('build_id')}), unpinned")
    return pointer


def list_builds(store: Store) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """latest.json and builds.json; an entry whose files are gone carries ``incomplete: True``."""
    builds: list[dict[str, Any]] = _read_json(store, BUILDS_KEY) or []
    for entry in builds:
        if not build_is_complete(store, entry):
            entry["incomplete"] = True
    return _read_json(store, LATEST_KEY) or {}, builds


FINDINGS_HISTORY_KEY = "notebooks/findings-history.json"
FINDINGS_HISTORY_KEEP = 90


def findings_history(
    store: Store,
    build_id: str | None = None,
    *,
    keep: int = FINDINGS_HISTORY_KEEP,
    log: Log = print,
) -> dict[str, Any]:
    """Append a build's notebook findings to the history the Notebooks page charts.

    The findings a build publishes (``builds/<id>/notebooks/<nb>.findings.json``) die with the
    build after seven builds; the history at ``notebooks/findings-history.json`` keeps, per
    notebook and league, the headline, the evidence count and the facts of the last ``keep``
    builds, one entry per build (a build run twice replaces its entry). The Worker serves the file
    with the pointers' short cache.
    """
    if build_id is None:
        latest = _read_json(store, LATEST_KEY) or {}
        build_id = latest.get("build_id")
    if not build_id:
        msg = "no build to take the findings from"
        raise RuntimeError(msg)
    prefix = f"builds/{build_id}/notebooks/"
    index = _read_json(store, prefix + "index.json") or {}
    manifest = _read_json(store, f"builds/{build_id}/manifest.json") or {}
    # a build without a manifest (the tests, a hand-made build) is dated now
    created_at = str(manifest.get("created_at") or datetime.now(UTC).isoformat())
    history: dict[str, Any] = _read_json(store, FINDINGS_HISTORY_KEY) or {"notebooks": {}}
    notebooks: dict[str, dict[str, list[dict[str, Any]]]] = history.setdefault("notebooks", {})
    added = 0
    for name in index.get("files", []):
        if not name.endswith(".findings.json"):
            continue
        findings = _read_json(store, prefix + name) or {}
        notebook = name.removesuffix(".findings.json")
        for league, f in (findings.get("leagues") or {}).items():
            if not isinstance(f, dict):
                continue
            entry = {
                "build_id": build_id,
                "created_at": created_at,
                "headline": str(f.get("headline", "")),
                "n": f.get("n"),
                "insufficient_history": bool(f.get("insufficient_history", False)),
                "facts": {
                    str(x.get("label")): x.get("value")
                    for x in f.get("facts", [])
                    if isinstance(x, dict) and x.get("label") is not None
                },
            }
            series = [
                e
                for e in notebooks.setdefault(notebook, {}).setdefault(league, [])
                if e.get("build_id") != build_id
            ]
            series.append(entry)
            series.sort(key=lambda e: (str(e.get("created_at", "")), str(e.get("build_id", ""))))
            notebooks[notebook][league] = series[-keep:]
            added += 1
    history["updated_at"] = created_at
    store.put(FINDINGS_HISTORY_KEY, to_json(history))
    entries = f"{added} league entr{'y' if added == 1 else 'ies'}"
    log(f"  findings history: {entries} from {build_id} -> {FINDINGS_HISTORY_KEY}")
    return history


def carry_forward(
    store: Store,
    build_id: str,
    subdirs: tuple[str, ...] = ("notebooks", "tableau"),
    *,
    log: Log = print,
) -> dict[str, str | None]:
    """Copy the newest earlier build's notebooks and Tableau extract into a staged light build.

    The evening light build refreshes the data only (runbook, "light build"); without this it went
    live with no ``notebooks/`` or ``tableau/`` folder, and the Notebooks and Dashboards pages said
    nothing was rendered until the next full build (#530). Each folder is copied whole from the
    newest build in builds.json that has it, its index.json says where it came from
    (``carried_from``, ``carried_from_created_at``; a folder carried twice keeps the original), and
    the build's key list grows so pruning removes the copies with the build. Returns, per folder,
    the build it came from, or None when no earlier build has it.
    """
    builds: list[dict[str, Any]] = _read_json(store, BUILDS_KEY) or []
    listing = store.get(f"builds/{build_id}/keys.txt")
    known = listing.decode("utf-8").splitlines() if listing else []
    added: list[str] = []
    carried: dict[str, str | None] = {}
    for subdir in subdirs:
        sub = subdir.strip("/")
        source: tuple[dict[str, Any], dict[str, Any]] | None = None
        for entry in builds:
            other = entry.get("build_id")
            if not other or other == build_id:
                continue
            index = _read_json(store, f"builds/{other}/{sub}/index.json")
            if index and index.get("files"):
                source = (entry, index)
                break
        if source is None:
            log(f"  {sub}: no earlier build has it; nothing carried")
            carried[sub] = None
            continue
        entry, index = source
        src = f"builds/{entry['build_id']}/{sub}/"
        dst = f"builds/{build_id}/{sub}/"
        files: list[str] = []
        for name in index["files"]:
            body = store.get(src + name)
            if body is None:
                continue
            store.put(dst + name, body)
            files.append(name)
            added.append(dst + name)
        origin = str(index.get("carried_from") or entry["build_id"])
        origin_at = str(index.get("carried_from_created_at") or entry.get("created_at", ""))
        store.put(
            dst + "index.json",
            to_json(
                {
                    "build_id": build_id,
                    "files": files,
                    "carried_from": origin,
                    "carried_from_created_at": origin_at,
                }
            ),
        )
        added.append(dst + "index.json")
        log(f"  {sub}: carried {len(files)} file(s) from {origin}")
        carried[sub] = origin
    extra = [k for k in added if k not in known]
    if extra:
        store.put(f"builds/{build_id}/keys.txt", "\n".join([*known, *extra]).encode("utf-8"))
    return carried


def publish_files(
    store: Store,
    files: list[Path],
    *,
    subdir: str,
    build_id: str | None = None,
    log: Log = print,
) -> list[str]:
    """Put extra files (rendered notebooks, the Tableau extract) under ``builds/<id>/<subdir>/``.

    The folder's index.json lists them, and the build's key list grows so pruning removes them.
    """
    if build_id is None:
        latest = _read_json(store, LATEST_KEY) or {}
        build_id = latest.get("build_id")
    if not build_id:
        msg = "no build to attach the files to"
        raise RuntimeError(msg)
    prefix = f"builds/{build_id}/{subdir.strip('/')}/"
    keys: list[str] = []
    for file in files:
        key = prefix + file.name
        store.put(key, file.read_bytes())
        keys.append(key)
    index = {"build_id": build_id, "files": [f.name for f in files]}
    store.put(prefix + "index.json", to_json(index))
    # Extend the build's key list so pruning removes the notebooks with the build.
    listing = store.get(f"builds/{build_id}/keys.txt")
    known = listing.decode("utf-8").splitlines() if listing else []
    extra = [k for k in [*keys, prefix + "index.json"] if k not in known]
    if extra:
        store.put(f"builds/{build_id}/keys.txt", "\n".join([*known, *extra]).encode("utf-8"))
    log(f"  {subdir} -> {prefix} ({len(keys)} files)")
    return keys
