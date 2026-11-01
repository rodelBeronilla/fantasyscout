"""Refresh the web app's test fixture: the JSON files of a real build, trimmed to one league.

    uv run python -m export.fixture            # JSON from the live build, Parquet from the sample
    uv run python -m export.fixture --local    # everything from the local lakehouse

The Playwright tests serve ``web/tests/fixtures/data`` as the site's data, so the pages are tested
against the files and keys the export produces. The fixture keeps what the pages read: every JSON
file of the build, with the per-league and history files trimmed to the fixture league's current
season, and that league's player files. The Parquet mirror, which the Worker serves to the owner
alone, comes from the dbt sample's export instead (the SQL console only needs its shape); the
play-by-play is left out to keep the fixture small. The build id, timestamp and commit are
pinned so a refresh changes only what the data changed. ``tests/test_fixture_contract.py`` fails
when the committed fixture and the export disagree on files or keys.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import httpx
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from export import build as build_mod
from export import layout
from export.encode import sha256, to_json
from export.source import DuckDBSource
from export.store import LocalStore

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_ROOT = ROOT / "web" / "tests" / "fixtures" / "data"
SITE = "https://fantasyscout.beronilla.rodeo"
BUILD_ID = "fixture"
CREATED_AT = "2026-10-29T18:33:44+00:00"
GIT_SHA = "fixture"
# The league whose player files and history rows the fixture carries; the other league keeps its
# per-league JSON (the pages read both) but no player files.
LEAGUE = "wnba"
SEASON = "2026"
# Files left out of the fixture: the play-by-play (large, read by no page) and the Parquet of other
# league-seasons. The Parquet that stays is trimmed to the fixture league's season, so the SQL
# console has every table at a fraction of the size.
SKIP_PREFIXES = ("fct_event/",)
# Files a build gains after staging (the notebooks and the Tableau extract add themselves): the
# pages read these indexes and findings, so the fixture carries them from a live build.
SIDE_FILES = ("notebooks/index.json", "tableau/index.json")
# Player files kept: the top of the board and of the streamers list, which is where the tests click,
# each with its history cut to the fixture season's last games.
BOARD_PLAYERS = 60
STREAMER_PLAYERS = 40
RECENT_GAMES = 12
RECENT_SHOTS = 150


def keeps(path: str) -> bool:
    """Whether a build file belongs in the fixture."""
    if path.startswith(SKIP_PREFIXES):
        return False
    if path.startswith("players/"):
        return path.startswith(f"players/{LEAGUE}/") and path.endswith(".json")
    if path.endswith(".parquet"):
        # Partitioned facts: the fixture league's season only.
        return "/" not in path or path.endswith(f"/{LEAGUE}-{SEASON}.parquet")
    return path.endswith(".json")


def trim_parquet(body: bytes) -> bytes:
    """A Parquet file cut to the fixture league's season where it has those columns."""
    table = pq.read_table(pa.BufferReader(body))
    if "league" in table.column_names:
        table = table.filter(pc.equal(table["league"], LEAGUE))
    if "season" in table.column_names:
        table = table.filter(pc.equal(pc.cast(table["season"], pa.string()), SEASON))
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink, compression="zstd")
    return bytes(sink.getvalue().to_pybytes())


def trim(path: str, body: bytes) -> bytes:
    """Root tables trimmed to the fixture league's current season; everything else as is.

    The teams stay whole: the streamers page draws its week grid from the league's teams, and the
    tests open whichever league has a game ahead, which is the NBA while the WNBA is out of
    season."""
    if path.endswith(".parquet"):
        return trim_parquet(body)
    if "/" in path or path in (
        "health.json",
        "manifest.json",
        "category_config.json",
        "dim_team.json",
    ):
        return body
    data = json.loads(body)
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        return body
    if "league" not in data[0]:
        return body
    rows = [r for r in data if r.get("league") == LEAGUE]
    if "season" in data[0]:
        rows = [r for r in rows if str(r.get("season")) == SEASON]
    return to_json(rows)


def player_ids(files: dict[str, bytes]) -> set[str]:
    """Players whose files the fixture carries: the top of the board and of the streamers."""
    ids: set[str] = set()
    for name, count in (("board", BOARD_PLAYERS), ("streamers", STREAMER_PLAYERS)):
        body = files.get(f"{name}/{LEAGUE}.json")
        for row in (json.loads(body) if body else [])[:count]:
            ids.add(str(row["player_id"]))
    return ids


def trim_player(body: bytes) -> bytes:
    """A player file with its history cut to the fixture season; every key stays."""
    player = json.loads(body)
    for section, rows in player.items():
        if not isinstance(rows, list) or not rows:
            continue
        if isinstance(rows[0], dict) and "season" in rows[0]:
            kept = [r for r in rows if str(r.get("season")) == SEASON] or rows[-1:]
            player[section] = kept if section == "seasons" else kept[-RECENT_GAMES:]
        elif section == "shots":
            player[section] = rows[-RECENT_SHOTS:]
    return to_json(player)


def from_live(site: str, log: Callable[[str], None] = print) -> dict[str, bytes]:
    """The current live build's files, as the fixture keeps them."""
    base = site.rstrip("/") + "/data/"
    files: dict[str, bytes] = {}
    with httpx.Client(timeout=60, headers={"cache-control": "no-cache"}) as client:
        latest = client.get(base + "latest.json").raise_for_status().json()
        manifest = client.get(base + latest["manifest"]).raise_for_status().json()
        prefix = f"builds/{latest['build_id']}/"
        log(f"live build {latest['build_id']}: {len(manifest['files'])} files")
        # The Parquet mirror is served to the owner alone; the sample supplies it.
        for path in sorted(p for p in manifest["files"] if keeps(p) and not p.endswith(".parquet")):
            files[path] = trim(path, client.get(base + prefix + path).raise_for_status().content)
        for pid in sorted(player_ids(files)):
            path = f"players/{LEAGUE}/{pid}.json"
            response = client.get(base + prefix + path)
            if response.status_code == 200:
                files[path] = trim_player(response.content)
        for index in SIDE_FILES:
            response = client.get(base + prefix + index)
            if response.status_code != 200:
                continue
            files[index] = response.content
            folder = index.rsplit("/", 1)[0]
            for name in json.loads(response.content).get("files", []):
                if name.endswith(".json"):
                    files[f"{folder}/{name}"] = (
                        client.get(base + prefix + folder + "/" + name).raise_for_status().content
                    )
    return files


def export_of(path: Path, log: Callable[[str], None] = print) -> build_mod.Build:
    """The current code's export of a local lakehouse."""
    source = DuckDBSource(path)
    try:
        return build_mod.assemble(
            source,
            engine="duckdb",
            git_sha=GIT_SHA,
            build_id=BUILD_ID,
            created_at=CREATED_AT,
            skip_tables=frozenset({"fct_event"}),
            log=log,
        )
    finally:
        source.close()


def _align(row: object, keys: list[str]) -> object:
    return {k: row.get(k) for k in keys} if isinstance(row, dict) else row


def _keys_of(body: bytes) -> list[str]:
    data = json.loads(body)
    rows = data if isinstance(data, list) else [data]
    keys: list[str] = []
    for row in rows:
        if isinstance(row, dict):
            keys.extend(k for k in row if k not in keys)
    return keys


def conform(files: dict[str, bytes], shape: build_mod.Build, duckdb: Path) -> dict[str, bytes]:
    """The live files with the keys the current code exports.

    The live build ran the code of its day; a column added since then is missing from its files
    and one dropped since is still there. Each file's rows take the keys the code's export gives
    them (from the sample's export, or the export query's schema where the sample has no rows):
    a new column is null until the next build, a dropped one goes. The fixture is then always
    the shape of the code with the newest values the site has.
    """
    source = DuckDBSource(duckdb)
    try:
        per_league = {
            name: list(source.query(sql).schema.names) for name, sql in layout.PER_LEAGUE_JSON
        }
    finally:
        source.close()
    board_keys = list(layout.PLAYER_BOARD_COLUMNS)
    sample_player = next((p for p in sorted(shape.files) if p.startswith("players/")), None)
    player_shape = json.loads(shape.files[sample_player]) if sample_player else {}
    out: dict[str, bytes] = {}
    for path, body in files.items():
        if not path.endswith(".json") or path.startswith(("notebooks/", "tableau/")):
            out[path] = body
            continue
        data = json.loads(body)
        if path.startswith("players/"):
            player = {k: data.get(k) for k in player_shape} if player_shape else data
            for section, value in player.items():
                sample = player_shape.get(section)
                if (
                    isinstance(value, list)
                    and isinstance(sample, list)
                    and sample
                    and isinstance(sample[0], dict)
                ):
                    player[section] = [_align(r, list(sample[0])) for r in value]
                elif section == "board" and isinstance(value, dict):
                    player[section] = _align(value, board_keys)
            out[path] = to_json(player)
            continue
        name = path.split("/")[0]
        keys = (
            per_league.get(name)
            if "/" in path
            else (
                _keys_of(shape.files[path])
                if path in shape.files and json.loads(shape.files[path])
                else None
            )
        )
        if path == "health.json":
            keys = _keys_of(shape.files["health.json"])
            out[path] = to_json(_align(data, keys))
        elif keys and isinstance(data, list):
            out[path] = to_json([_align(r, keys) for r in data])
        else:
            out[path] = body
    return out


def from_duckdb(
    path: Path, log: Callable[[str], None] = print, *, parquet_only: bool = False
) -> dict[str, bytes]:
    """A local lakehouse's export, as the fixture keeps it (or just its Parquet)."""
    build = export_of(path, log)
    wanted = player_ids(build.files)
    files: dict[str, bytes] = {}
    for name, body in build.files.items():
        if not keeps(name) or (parquet_only and not name.endswith(".parquet")):
            continue
        if name.startswith("players/"):
            if name.removeprefix(f"players/{LEAGUE}/").removesuffix(".json") in wanted:
                files[name] = trim_player(body)
        else:
            files[name] = trim(name, body)
    return files


def write(files: dict[str, bytes], out: Path, log: Callable[[str], None] = print) -> None:
    """Publish the files as build ``fixture`` under ``out``, replacing the previous fixture."""
    build = build_mod.Build(
        build_id=BUILD_ID, engine="duckdb", git_sha=GIT_SHA, created_at=CREATED_AT
    )
    health: dict[str, Any] = json.loads(files["health.json"])
    health.update({"build_id": BUILD_ID, "created_at": CREATED_AT, "git_sha": GIT_SHA})
    files = {**files, "health.json": to_json(health)}
    for path, body in files.items():
        build.files[path] = body
    players = [p for p in files if p.startswith("players/")]
    # The SQL console makes one view per table from the manifest's Parquet files.
    schema_of = {spec.name: spec.table for spec in (*layout.GOLD, *layout.OPS)}
    tables: dict[str, dict[str, Any]] = {}
    for path, body in files.items():
        if not path.endswith(".parquet"):
            continue
        name = path.split("/")[0].removesuffix(".parquet")
        entry = tables.setdefault(schema_of.get(name, f"gold.{name}"), {"rows": 0, "files": []})
        entry["rows"] += pq.read_metadata(pa.BufferReader(body)).num_rows
        entry["files"].append(path)
    build.manifest = {
        "build_id": BUILD_ID,
        "created_at": CREATED_AT,
        "engine": "duckdb",
        "git_sha": GIT_SHA,
        "data_as_of": health.get("data_as_of", {}),
        "gate": health.get("gate"),
        "check_counts": health.get("check_counts", {}),
        "tables": tables,
        "files": {
            p: {"bytes": len(b), "sha256": sha256(b)}
            for p, b in files.items()
            if not p.startswith("players/")
        },
        "players": {"count": len(players), "prefix": "players/"},
    }
    shutil.rmtree(out / "builds" / BUILD_ID, ignore_errors=True)
    store = LocalStore(out)
    build_mod.publish(store, build, keep=1, log=log)
    log(f"fixture: {len(files)} files ({len(players)} player files) under {out}")


def committed_files(out: Path = FIXTURE_ROOT) -> Iterable[str]:
    """The build files the committed fixture holds (manifest and key list aside)."""
    root = out / "builds" / BUILD_ID
    for p in root.rglob("*"):
        if p.is_file() and p.name not in ("manifest.json", "keys.txt"):
            yield p.relative_to(root).as_posix()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--site", default=SITE, help="the site to take the live build from")
    parser.add_argument("--duckdb", type=Path, default=ROOT / "dbt" / "fantasyscout.duckdb")
    parser.add_argument("--local", action="store_true", help="take everything from --duckdb")
    parser.add_argument("--out", type=Path, default=FIXTURE_ROOT)
    args = parser.parse_args(argv)
    if not args.duckdb.exists():
        print(f"{args.duckdb} is missing: build the dbt sample first (see CONTRIBUTING.md)")
        return 2
    if args.local:
        files = from_duckdb(args.duckdb)
    else:
        shape = export_of(args.duckdb, log=lambda _: None)
        files = {
            **from_duckdb(args.duckdb, parquet_only=True),
            **conform(from_live(args.site), shape, args.duckdb),
        }
        # A file the code exports but the live build predates (a new per-league JSON) comes from
        # the sample's export, so the fixture is the shape of the code here too.
        for path, body in shape.files.items():
            if (
                keeps(path)
                and path.endswith(".json")
                and not path.startswith("players/")
                and path not in files
            ):
                files[path] = trim(path, body)
    if not files.get(f"board/{LEAGUE}.json") or not json.loads(files[f"board/{LEAGUE}.json"]):
        print(f"the {LEAGUE} board is empty: the fixture needs a source with a populated board")
        return 2
    write(files, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
