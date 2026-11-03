"""Write the schema the app's Schema and Pipeline pages render, from the dbt project.

    cd dbt && uv run dbt build --target duckdb --exclude tag:quality
    uv run dbt docs generate --target duckdb && cd ..
    uv run python -m ops.schema                 # write web/src/generated/schema.json
    uv run python -m ops.schema --check         # exit 1 when the committed file is out of date
    uv run python -m ops.schema --require-docs  # exit 1 when an exported gold column lacks docs

Reads dbt's ``manifest.json`` (models, descriptions, lineage, tests, unit tests) and
``catalog.json`` (column types as built on DuckDB, the engine of the fixture build; the page
lists their Databricks equivalents) and writes one compact, deterministic JSON file: every model
by layer with its description, the comment block at the top of its SQL (where the method is
written down), its grain (the columns of its ``sk([...])`` key), the landing folders a bronze
model reads, columns with types, descriptions and tests, what it reads, what reads it, and the
files of a published build that carry it (from ``export/layout.py`` and ``export/players.py``);
the seeds; the singular data-quality checks with their severities; the unit tests; the tested
relationships (foreign keys); and the fantasy settings from ``dbt_project.yml``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from export import layout

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "dbt" / "target"
OUT = ROOT / "web" / "src" / "generated" / "schema.json"
PLAYERS_PY = ROOT / "export" / "players.py"
LAYERS = ("bronze", "silver", "gold", "ops")
PROJECT = "fantasyscout"

_JINJA_COMMENT = re.compile(r"\{#(.*?)#\}", re.S)
_CONFIG_OPEN = re.compile(r"\s*\{\{\s*config\(")
_CLOSING_BRACES = re.compile(r"\s*\}\}")
_REF = re.compile(r"ref\(['\"]([^'\"]+)['\"]\)")
_SK = re.compile(r"\{\{\s*sk\(\s*\[(.*?)\]\s*\)\s*\}\}\s+as\s+(\w+)", re.S)
_QUOTED = re.compile(r"'([^']*)'|\"([^\"]*)\"")
_CAST = re.compile(r"^cast\((.*)\s+as\s+\w+\)$", re.I)
_LANDING = re.compile(r"landing_files\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)")
_RAW_JSON = re.compile(r"raw_json_files\(\s*['\"]landing/(.+?)/\*")
_WAREHOUSE_TABLE = re.compile(r"\b(?:from|join)\s+(?:gold|ops)\.(\w+)", re.I)
_BARE_TABLE = re.compile(r"\b(?:from|join)\s+([a-z_][a-z0-9_]*)\b")


def _paragraphs(text: str) -> list[str]:
    """A comment block as paragraphs: blank lines split them, other line breaks are spaces.

    A line starting with "-" begins a bullet, kept as its own paragraph."""
    out: list[str] = []
    current: list[str] = []
    for raw in text.strip("\n").splitlines():
        line = raw.strip()
        if not line or line.startswith("- "):
            if current:
                out.append(" ".join(current))
            current = [line] if line else []
            continue
        current.append(line)
    if current:
        out.append(" ".join(current))
    return [p for p in out if p]


def skip_leading_config(code: str) -> str:
    """The code after any leading ``{{ config(...) }}`` calls.

    A hook inside the config is itself Jinja and can end in ``) }}``, so the call's end is found
    by balancing its parentheses, not at the first closing braces."""
    rest = code
    while m := _CONFIG_OPEN.match(rest):
        depth, i = 1, m.end()
        while i < len(rest) and depth:
            depth += {"(": 1, ")": -1}.get(rest[i], 0)
            i += 1
        close = _CLOSING_BRACES.match(rest, i)
        if depth or not close:
            break
        rest = rest[close.end() :]
    return rest


def model_notes(raw_code: str) -> list[str]:
    """The leading ``{# ... #}`` block of a model, where its method is described.

    A ``{{ config(...) }}`` call may come first (every bronze model has one); it is skipped."""
    rest = skip_leading_config(raw_code)
    m = _JINJA_COMMENT.search(rest)
    if not m or rest[: m.start()].strip():
        return []
    return _paragraphs(m.group(1))


def test_notes(raw_code: str) -> str:
    """The ``--`` comment lines at the top of a singular test, joined."""
    lines = []
    for raw in raw_code.splitlines():
        line = raw.strip()
        if line.startswith("{{") and "config" in line:
            continue
        if line.startswith("--"):
            lines.append(line.lstrip("-").strip())
        elif line:
            break
    return " ".join(lines)


def _key_part(expr: str, columns: set[str]) -> str:
    """One part of an ``sk([...])`` call as the column it names: no table alias, no cast.

    The SQL can name a column before it is renamed (dim_player keys on ``player_id`` and
    publishes it as ``stats_player_id``); the published name is used when only it exists."""
    expr = expr.strip()
    if cast := _CAST.match(expr):
        expr = cast.group(1).strip()
    name = expr.rsplit(".", 1)[-1]
    if name not in columns and f"stats_{name}" in columns:
        return f"stats_{name}"
    return name


def model_grain(raw_code: str, columns: set[str], key: str | None) -> dict[str, Any] | None:
    """The grain of a model: the columns of its own ``sk([...])`` surrogate key.

    The model's key is the ``sk`` column a ``unique`` test covers; failing that, the first
    ``sk`` call (a fact also builds the keys of the dimensions it points at)."""
    calls = [(m.group(2), m.group(1)) for m in _SK.finditer(raw_code)]
    if not calls:
        return None
    chosen = next((c for c in calls if c[0] == key), calls[0])
    parts = [_key_part(a or b, columns) for a, b in _QUOTED.findall(chosen[1])]
    return {"key": chosen[0], "columns": parts}


# The left end of the lineage: who lands each source, from where, on which runner, how often. The
# landing folders a bronze model reads (``landing/<source>/<endpoint>``) join a source by their
# first segment.
SOURCES: dict[str, dict[str, str]] = {
    "stats": {
        "name": "League stats API",
        "host": "stats.nba.com, stats.wnba.com",
        "module": "ingest/stats.py",
        "runner": "the home runner (ADR 0002: the host blocks cloud addresses)",
        "cadence": "daily, morning and evening; backfills by season (ingest.yml, backfill.yml)",
    },
    "espn": {
        "name": "ESPN",
        "host": "site.api.espn.com, site.web.api.espn.com",
        "module": "ingest/espn.py, espn_fantasy.py, espn_news.py, transactions.py, props.py",
        "runner": "GitHub-hosted",
        "cadence": "daily, morning and evening (ingest.yml)",
    },
    "league": {
        "name": "The leagues' own sites",
        "host": "official.nba.com and the WNBA's equivalent",
        "module": "ingest/injury_report.py, lineups.py, referee_assignments.py, transactions.py",
        "runner": "GitHub-hosted",
        "cadence": "morning and evening in season; the injury-report archive landed once "
        "(ingest.yml)",
    },
    "sleeper": {
        "name": "Sleeper",
        "host": "api.sleeper.app",
        "module": "ingest/sleeper.py",
        "runner": "GitHub-hosted",
        "cadence": "daily (ingest.yml)",
    },
    "odds_api": {
        "name": "The Odds API",
        "host": "api.the-odds-api.com",
        "module": "ingest/props.py",
        "runner": "GitHub-hosted",
        "cadence": "twice daily, behind ODDS_API_KEY (ingest.yml)",
    },
    "_ops": {
        "name": "The ingest's own run log",
        "host": "written by every ingest run",
        "module": "ingest/run.py",
        "runner": "wherever the run ran",
        "cadence": "every run",
    },
}


def sources_of(landing_paths: list[str]) -> list[dict[str, Any]]:
    """The sources behind the landing folders, each with the folders it lands."""
    by_source: dict[str, list[str]] = {}
    for path in landing_paths:
        by_source.setdefault(path.split("/", 1)[0], []).append(path)
    out = []
    for key, folders in sorted(by_source.items()):
        info = SOURCES.get(
            key, {"name": key, "host": "", "module": "", "runner": "", "cadence": ""}
        )
        out.append({"key": key, **info, "folders": sorted(folders)})
    return out


# fetchCurrentJson reads the same files at their stable address (#436)
_FETCH = re.compile(r"(?:fetchBuildJson|fetchCurrentJson|fetchPageRows)<[^>]*>\(\s*[`'\"]([a-z_]+)")
_COMPONENT_IMPORT = re.compile(
    r"import\s+([A-Z][A-Za-z]+)\s+from\s+'\.\.?/(?:\.\./)?components/([A-Za-z]+)'"
)


def page_reads(web_src: Path) -> dict[str, list[str]]:
    """Which site routes read each published file name: ``board`` -> ``['/']`` and so on.

    A page is a ``.astro`` file under ``pages/``; the files it reads are the ``fetchBuildJson`` and
    ``fetchPageRows`` calls
    of the
    components it imports (the per-player file reads ``players/<league>/<id>.json``, named here as
    ``players``). The right end of the lineage, read off the code rather than kept by hand.
    """
    pages_dir = web_src / "pages"
    components = web_src / "components"
    if not pages_dir.is_dir() or not components.is_dir():
        return {}
    reads_of: dict[str, set[str]] = {}
    for comp in components.glob("*.tsx"):
        names = set(_FETCH.findall(comp.read_text(encoding="utf-8", errors="ignore")))
        if names:
            reads_of[comp.stem] = names
    out: dict[str, set[str]] = {}
    for page in pages_dir.rglob("*.astro"):
        rel = page.relative_to(pages_dir).as_posix()
        route = (
            "/"
            if rel == "index.astro"
            else "/" + rel.removesuffix("index.astro").removesuffix(".astro").rstrip("/") + "/"
        )
        for _, comp in _COMPONENT_IMPORT.findall(page.read_text(encoding="utf-8", errors="ignore")):
            for name in reads_of.get(comp, set()):
                out.setdefault(name, set()).add(route)
    return {name: sorted(routes) for name, routes in sorted(out.items())}


def pages_reading(exported_as: list[str], pages: dict[str, list[str]]) -> list[str]:
    """The routes that read any of a model's published files (``board/<league>.json`` is
    ``board``)."""
    routes: set[str] = set()
    for file in exported_as:
        name = file.split("/", 1)[0].removesuffix(".json").removesuffix(".parquet")
        routes.update(pages.get(name, []))
    return sorted(routes)


def landing_reads(raw_code: str) -> list[str]:
    """The landing folders (``<source>/<endpoint>``) a model reads its files from."""
    found = {f"{s}/{e}" for s, e in _LANDING.findall(raw_code)}
    found.update(_RAW_JSON.findall(raw_code))
    return sorted(found)


def export_consumers(players_source: str, gold_names: set[str]) -> dict[str, list[str]]:
    """The files of a published build that carry each table, from the export's own layout.

    Every table in ``layout.TABLES`` goes out whole as Parquet (per league-season when
    partitioned) and the small ones as JSON; the per-league JSON files select from the tables
    their SQL names; the per-player files read the gold tables ``players.py`` queries."""
    out: dict[str, list[str]] = {}

    def add(table: str, path: str) -> None:
        out.setdefault(table, [])
        if path not in out[table]:
            out[table].append(path)

    for spec in layout.TABLES:
        if spec.partition:
            add(spec.name, f"{spec.name}/<league>-<season>.parquet")
        else:
            add(spec.name, f"{spec.name}.parquet")
        if spec.json:
            add(spec.name, f"{spec.name}.json")
    for name, sql in layout.PER_LEAGUE_JSON:
        for table in _WAREHOUSE_TABLE.findall(sql):
            add(table, f"{name}/<league>.json")
    for table in _WAREHOUSE_TABLE.findall(layout.DATA_AS_OF_SQL):
        add(table, "health.json (data as of)")
    for table in sorted(set(_BARE_TABLE.findall(players_source)) & gold_names):
        add(table, "players/<league>/<player_id>.json")
    return out


def exported_columns(schema: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """The columns a published build carries, by gold model: every column of each gold model
    in ``layout.GOLD`` (each goes out whole), which covers the board's and streamers' JSON."""
    gold = {m["name"]: m for layer in schema["layers"] for m in layer["models"]}
    out: dict[str, list[dict[str, Any]]] = {}
    for spec in layout.GOLD:
        model = gold.get(spec.name)
        out[spec.name] = model["columns"] if model else []
    return out


# The column conventions the Schema page states and --require-docs holds the yml to. A column
# whose name or type makes the convention apply says nothing; one that departs from it says so in
# ``meta``: ``tz`` for an instant (UTC unless stated), ``unit`` for a measure, ``null_when`` for a
# column that is null by design. Every timestamp column carries ``meta.tz`` explicitly.
CONVENTIONS: tuple[dict[str, str], ...] = (
    {
        "name": "dates",
        "rule": "A `*_date` column (and `date_day`, `valid_from`, `valid_to`, `week_start`) is the "
        "Eastern game date: the day the league counts the game on, which is the day it is "
        "played in the US. A UTC date says so (`*_date_utc`); bronze keeps a source's own field "
        "names, so ESPN's `event_date` there is the tip-off time as text.",
    },
    {
        "name": "instants",
        "rule": "A `*_at` or `*_datetime_utc` column is an instant, in UTC unless its `tz` badge "
        "says otherwise (the official injury reports are published in Eastern time and kept "
        "so). Every timestamp column carries `tz`.",
    },
    {
        "name": "units",
        "rule": "Minutes are minutes, distances miles (`*_miles_travelled`), heights inches, "
        "weights pounds, percentages ratios from 0 to 1 (`*_pct`), latencies milliseconds "
        "(`*_ms`); a `*_pg` column is per game played. A `unit` badge says so where the name "
        "alone would not.",
    },
    {
        "name": "nulls",
        "rule": "Null means not known or not applicable, never zero; a `null_when` badge says the "
        "condition where it is by design (a listing without a return date, a game without a line).",
    },
)

TZ_OF: dict[str, str] = {"utc": "UTC", "eastern": "America/New_York"}


def column_meta(doc: dict[str, Any]) -> dict[str, str]:
    """The ``meta`` keys the conventions know (tz, unit, null_when), as strings."""
    meta = doc.get("meta") or {}
    return {
        k: str(meta[k])
        for k in ("tz", "unit", "null_when")
        if k in meta and meta[k] not in (None, "")
    }


def undocumented(schema: dict[str, Any]) -> list[str]:
    """Exported gold columns with no description or, for a timestamp, no time zone; and per-league
    JSON columns the model lacks."""
    problems: list[str] = []
    exported = exported_columns(schema)
    for name, cols in exported.items():
        if not cols:
            problems.append(f"{name}: not in the dbt project")
        for col in cols:
            if not str(col.get("description", "")).strip():
                problems.append(f"{name}.{col['name']}: no description")
            if str(col.get("type", "")).startswith("timestamp") and not col.get("meta", {}).get(
                "tz"
            ):
                problems.append(f"{name}.{col['name']}: a timestamp without meta.tz")
    for model, wanted in (
        ("mart_board", layout.BOARD_COLUMNS),
        ("mart_streamers", layout.STREAMER_COLUMNS),
        ("mart_board", layout.PLAYER_BOARD_COLUMNS),
        ("mart_player_rolling", layout.PLAYER_ROLLING_COLUMNS),
        ("mart_category_zscores", layout.PLAYER_ZSCORE_COLUMNS),
    ):
        have = {c["name"] for c in exported.get(model, [])}
        problems.extend(f"{model}.{c}: exported but not a column" for c in wanted if c not in have)
    return problems


def build(
    manifest: dict[str, Any],
    catalog: dict[str, Any],
    project_vars: dict[str, Any],
    players_source: str = "",
) -> dict[str, Any]:
    nodes: dict[str, Any] = manifest["nodes"]
    cat_nodes: dict[str, Any] = catalog.get("nodes", {})

    models = {
        k: v
        for k, v in nodes.items()
        if v["resource_type"] == "model" and v["package_name"] == PROJECT
    }
    seeds = {
        k: v
        for k, v in nodes.items()
        if v["resource_type"] == "seed" and v["package_name"] == PROJECT
    }
    tests = {
        k: v
        for k, v in nodes.items()
        if v["resource_type"] == "test" and v["package_name"] == PROJECT
    }
    names = {k: v["name"] for k, v in {**models, **seeds}.items()}

    column_tests: dict[tuple[str, str], list[str]] = {}
    relationships: list[dict[str, str]] = []
    singular: list[dict[str, Any]] = []
    model_checks: dict[str, list[str]] = {}
    for test in tests.values():
        meta = test.get("test_metadata")
        refs = sorted({names[n] for n in test["depends_on"]["nodes"] if n in names})
        if meta:
            column = test.get("column_name")
            attached = test.get("attached_node")
            if column and attached in names:
                column_tests.setdefault((names[attached], column), []).append(meta["name"])
                if meta["name"] == "relationships":
                    to = _REF.search(str(meta.get("kwargs", {}).get("to", "")))
                    if to:
                        relationships.append(
                            {
                                "from": names[attached],
                                "column": column,
                                "to": to.group(1),
                                "field": str(meta["kwargs"].get("field", "")),
                            }
                        )
            continue
        severity = str(test["config"].get("severity", "error")).lower()
        singular.append(
            {
                "name": test["name"],
                "severity": severity,
                "tags": sorted(t for t in test.get("tags", []) if t != "quality"),
                "about": test_notes(test.get("raw_code", "")),
                "reads": refs,
            }
        )
        for ref in refs:
            model_checks.setdefault(ref, []).append(test["name"])

    unit_tests = sorted(
        (
            {
                "name": u["name"],
                "model": u["model"],
                "description": " ".join(str(u.get("description", "")).split()),
            }
            for u in manifest.get("unit_tests", {}).values()
            if u.get("package_name") == PROJECT
        ),
        key=lambda u: (u["model"], u["name"]),
    )
    units_of: dict[str, list[dict[str, str]]] = {}
    for u in unit_tests:
        units_of.setdefault(u["model"], []).append(
            {"name": u["name"], "description": u["description"]}
        )

    referenced_by: dict[str, set[str]] = {}
    for node in models.values():
        for dep in node["depends_on"]["nodes"]:
            if dep in names:
                referenced_by.setdefault(names[dep], set()).add(node["name"])

    gold_names = {v["name"] for v in models.values() if v["schema"] == "gold"}
    consumers = export_consumers(players_source, gold_names)

    def columns(unique_id: str, node: dict[str, Any]) -> list[dict[str, Any]]:
        documented: dict[str, Any] = node.get("columns", {})
        built = cat_nodes.get(unique_id, {}).get("columns", {})
        ordered = sorted(built.values(), key=lambda c: c["index"]) if built else []
        out = []
        seen = set()
        for col in ordered:
            name = col["name"]
            seen.add(name)
            doc = documented.get(name, {})
            out.append(
                {
                    "name": name,
                    "type": str(col["type"]).lower(),
                    "description": doc.get("description", ""),
                    "meta": column_meta(doc),
                    "tests": sorted(set(column_tests.get((node["name"], name), []))),
                }
            )
        for name, doc in documented.items():
            if name not in seen:
                out.append(
                    {
                        "name": name,
                        "type": "",
                        "description": doc.get("description", ""),
                        "meta": column_meta(doc),
                        "tests": sorted(set(column_tests.get((node["name"], name), []))),
                    }
                )
        return out

    pages = page_reads(ROOT / "web" / "src")
    landing: dict[str, set[str]] = {}
    layers: list[dict[str, Any]] = []
    for layer in LAYERS:
        entries = []
        for unique_id, node in sorted(models.items(), key=lambda kv: kv[1]["name"]):
            if node["schema"] != layer:
                continue
            raw = node.get("raw_code", "")
            cols = columns(unique_id, node)
            key = next(
                (c["name"] for c in cols if c["name"].endswith("_sk") and "unique" in c["tests"]),
                None,
            )
            reads_landing = landing_reads(raw)
            for path in reads_landing:
                landing.setdefault(path, set()).add(node["name"])
            entries.append(
                {
                    "name": node["name"],
                    "materialized": node["config"].get("materialized", ""),
                    "description": node.get("description", ""),
                    "notes": model_notes(raw),
                    "grain": model_grain(raw, {c["name"] for c in cols}, key),
                    "landing": reads_landing,
                    "reads": sorted({names[d] for d in node["depends_on"]["nodes"] if d in names}),
                    "read_by": sorted(referenced_by.get(node["name"], set())),
                    "exported_as": consumers.get(node["name"], []),
                    "read_by_pages": pages_reading(consumers.get(node["name"], []), pages),
                    "checks": sorted(model_checks.get(node["name"], [])),
                    "unit_tests": units_of.get(node["name"], []),
                    "columns": cols,
                }
            )
        layers.append({"name": layer, "models": entries})

    # A model keyed on another model's surrogate key (mart_player_rolling carries
    # fct_player_game's player_game_sk) has that model's grain.
    grains = {
        m["grain"]["key"]: m["grain"]
        for layer_entry in layers
        for m in layer_entry["models"]
        if m["grain"]
    }
    for layer_entry in layers:
        for m in layer_entry["models"]:
            key = next(
                (c["name"] for c in m["columns"] if c["name"] in grains and "unique" in c["tests"]),
                None,
            )
            if not m["grain"] and key:
                m["grain"] = grains[key]

    seed_list = [
        {
            "name": node["name"],
            "description": node.get("description", ""),
            "read_by": sorted(referenced_by.get(node["name"], set())),
            "exported_as": consumers.get(node["name"], []),
            "columns": columns(unique_id, node),
        }
        for unique_id, node in sorted(seeds.items(), key=lambda kv: kv[1]["name"])
    ]
    fantasy = {
        k: project_vars[k]
        for k in (
            "fantasy",
            "fantasy_recency",
            "fantasy_durability",
            "fantasy_team_change",
            "fantasy_recent_minutes",
            "fantasy_return_ramp",
            "fantasy_matchup",
        )
        if k in project_vars
    }
    return {
        "layers": layers,
        "landing": [{"path": p, "read_by": sorted(landing[p])} for p in sorted(landing)],
        "sources": sources_of(sorted(landing)),
        "pages": [
            {"route": r, "reads": sorted(n for n, rs in pages.items() if r in rs)}
            for r in sorted({r for rs in pages.values() for r in rs})
        ],
        "seeds": seed_list,
        "checks": sorted(singular, key=lambda t: (t["severity"], t["name"])),
        "unit_tests": unit_tests,
        "relationships": sorted(relationships, key=lambda r: (r["from"], r["column"])),
        "generic_tests": sum(len(v) for v in column_tests.values()),
        "conventions": list(CONVENTIONS),
        "fantasy": fantasy,
    }


def project_vars() -> dict[str, Any]:
    """The `vars` of dbt_project.yml (the dbt group of the environment carries PyYAML)."""
    import yaml

    data = yaml.safe_load((ROOT / "dbt" / "dbt_project.yml").read_text(encoding="utf-8"))
    return dict(data.get("vars", {}))


def render(schema: dict[str, Any]) -> str:
    return json.dumps(schema, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target-dir", type=Path, default=TARGET)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--check", action="store_true", help="fail when the file on disk differs")
    parser.add_argument(
        "--require-docs",
        action="store_true",
        help="fail when a column a published build carries from gold has no description",
    )
    args = parser.parse_args(argv)

    manifest = json.loads((args.target_dir / "manifest.json").read_text(encoding="utf-8"))
    catalog = json.loads((args.target_dir / "catalog.json").read_text(encoding="utf-8"))
    schema = build(manifest, catalog, project_vars(), PLAYERS_PY.read_text(encoding="utf-8"))
    text = render(schema)
    status = 0
    if args.require_docs:
        problems = undocumented(schema)
        for problem in problems:
            print(f"::error::{problem}")
        if problems:
            print(f"{len(problems)} exported gold column(s) are not documented")
            status = 1
        else:
            print("every exported gold column is documented")
    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
        if current != text:
            print(
                f"::error::{args.out.relative_to(ROOT)} is stale; "
                "run `uv run python -m ops.schema` and commit"
            )
            return 1
        print(f"{args.out.relative_to(ROOT)} is current")
        return status
    if args.require_docs:
        return status
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8", newline="\n")
    models = sum(len(layer["models"]) for layer in schema["layers"])
    print(f"wrote {args.out.relative_to(ROOT)}: {models} models")
    return 0


if __name__ == "__main__":
    sys.exit(main())
