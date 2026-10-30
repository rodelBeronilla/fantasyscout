"""Write the schema the app's Schema and Pipeline pages render, from the dbt project.

    cd dbt && uv run dbt build --target duckdb --exclude tag:quality
    uv run dbt docs generate --target duckdb && cd ..
    uv run python -m ops.schema            # write web/src/generated/schema.json
    uv run python -m ops.schema --check    # exit 1 when the committed file is out of date

Reads dbt's ``manifest.json`` (models, descriptions, lineage, tests) and ``catalog.json``
(column types as built on DuckDB, whose schema matches the lakehouse) and writes one compact,
deterministic JSON file: every model by layer with its description, the comment block at the
top of its SQL (where the method is written down), columns with types, descriptions and
tests, what it reads and what reads it; the seeds; the singular data-quality checks with
their severities; the tested relationships (foreign keys); and the fantasy settings from
``dbt_project.yml``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "dbt" / "target"
OUT = ROOT / "web" / "src" / "generated" / "schema.json"
LAYERS = ("bronze", "silver", "gold", "ops")
PROJECT = "fantasyscout"

_JINJA_COMMENT = re.compile(r"\{#(.*?)#\}", re.S)
_REF = re.compile(r"ref\(['\"]([^'\"]+)['\"]\)")


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


def model_notes(raw_code: str) -> list[str]:
    """The leading ``{# ... #}`` block of a model, where its method is described."""
    m = _JINJA_COMMENT.search(raw_code)
    if not m or raw_code[: m.start()].strip():
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


def build(
    manifest: dict[str, Any], catalog: dict[str, Any], project_vars: dict[str, Any]
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

    referenced_by: dict[str, set[str]] = {}
    for node in models.values():
        for dep in node["depends_on"]["nodes"]:
            if dep in names:
                referenced_by.setdefault(names[dep], set()).add(node["name"])

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
                        "tests": sorted(set(column_tests.get((node["name"], name), []))),
                    }
                )
        return out

    layers: list[dict[str, Any]] = []
    for layer in LAYERS:
        entries = []
        for unique_id, node in sorted(models.items(), key=lambda kv: kv[1]["name"]):
            if node["schema"] != layer:
                continue
            entries.append(
                {
                    "name": node["name"],
                    "materialized": node["config"].get("materialized", ""),
                    "description": node.get("description", ""),
                    "notes": model_notes(node.get("raw_code", "")),
                    "reads": sorted({names[d] for d in node["depends_on"]["nodes"] if d in names}),
                    "read_by": sorted(referenced_by.get(node["name"], set())),
                    "checks": sorted(model_checks.get(node["name"], [])),
                    "columns": columns(unique_id, node),
                }
            )
        layers.append({"name": layer, "models": entries})

    seed_list = [
        {
            "name": node["name"],
            "description": node.get("description", ""),
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
            "fantasy_matchup",
        )
        if k in project_vars
    }
    return {
        "layers": layers,
        "seeds": seed_list,
        "checks": sorted(singular, key=lambda t: (t["severity"], t["name"])),
        "relationships": sorted(relationships, key=lambda r: (r["from"], r["column"])),
        "generic_tests": sum(len(v) for v in column_tests.values()),
        "fantasy": fantasy,
    }


def project_vars() -> dict[str, Any]:
    """The `vars` of dbt_project.yml (the dbt group of the environment carries PyYAML)."""
    import yaml  # type: ignore[import-untyped]

    data = yaml.safe_load((ROOT / "dbt" / "dbt_project.yml").read_text(encoding="utf-8"))
    return dict(data.get("vars", {}))


def render(schema: dict[str, Any]) -> str:
    return json.dumps(schema, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target-dir", type=Path, default=TARGET)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--check", action="store_true", help="fail when the file on disk differs")
    args = parser.parse_args(argv)

    manifest = json.loads((args.target_dir / "manifest.json").read_text(encoding="utf-8"))
    catalog = json.loads((args.target_dir / "catalog.json").read_text(encoding="utf-8"))
    text = render(build(manifest, catalog, project_vars()))
    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
        if current != text:
            print(
                f"::error::{args.out.relative_to(ROOT)} is stale; "
                "run `uv run python -m ops.schema` and commit"
            )
            return 1
        print(f"{args.out.relative_to(ROOT)} is current")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8")
    models = sum(len(layer["models"]) for layer in json.loads(text)["layers"])
    print(f"wrote {args.out.relative_to(ROOT)}: {models} models")
    return 0


if __name__ == "__main__":
    sys.exit(main())
