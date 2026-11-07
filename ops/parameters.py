"""The parameter registry (#765): methodology/parameters.yml, checked and turned into TypeScript.

    uv run python -m ops.parameters          # write web/src/generated/parameters.ts
    uv run python -m ops.parameters --check  # exit 1: the file is stale or the registry wrong

Every number the site's models and decisions use is registered with how it was set (measured,
assumed, convention, arithmetic), the evidence and the issue that will validate it. The web
reads values from the generated module, never from a literal; the dbt entries name the var they
mirror, and ``dbt_mismatches`` holds dbt_project.yml to the registry.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "methodology" / "parameters.yml"
DBT_PROJECT = ROOT / "dbt" / "dbt_project.yml"
OUT = ROOT / "web" / "src" / "generated" / "parameters.ts"

KINDS = {"model", "threshold", "search"}
STATUSES = {"measured", "assumed", "convention", "arithmetic"}
FIELDS = {"id", "value", "kind", "status", "what", "evidence", "validation", "dbt"}


def load(path: Path = REGISTRY) -> list[dict[str, Any]]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return list(data["parameters"])


def problems(params: list[dict[str, Any]]) -> list[str]:
    """What is wrong with the entries: missing or unknown fields, bad enums, duplicates."""
    found: list[str] = []
    seen: set[str] = set()
    for p in params:
        pid = str(p.get("id", "?"))
        missing = {"id", "value", "kind", "status", "what", "evidence", "validation"} - p.keys()
        if missing:
            found.append(f"{pid}: missing {sorted(missing)}")
        if extra := p.keys() - FIELDS:
            found.append(f"{pid}: unknown fields {sorted(extra)}")
        if p.get("kind") not in KINDS:
            found.append(f"{pid}: kind {p.get('kind')!r} is not one of {sorted(KINDS)}")
        if p.get("status") not in STATUSES:
            found.append(f"{pid}: status {p.get('status')!r} is not one of {sorted(STATUSES)}")
        if not isinstance(p.get("validation"), int):
            found.append(f"{pid}: validation must be the issue number that will test it")
        if pid in seen:
            found.append(f"{pid}: registered twice")
        seen.add(pid)
    return found


def _dbt_value(vars_: dict[str, Any], path: str) -> Any:
    """A dbt var by dotted path; a * segment collects that level's keys (fantasy.*.prior_games)."""
    head, _, rest = path.partition(".")
    if head == "*":
        return {k: _dbt_value(v, rest) if rest else v for k, v in vars_.items()}
    node = vars_[head]
    return _dbt_value(node, rest) if rest else node


def dbt_mismatches(params: list[dict[str, Any]], project: Path = DBT_PROJECT) -> list[str]:
    """Registry entries whose dbt var says something else."""
    vars_ = yaml.safe_load(project.read_text(encoding="utf-8"))["vars"]
    found: list[str] = []
    for p in params:
        if "dbt" not in p:
            continue
        try:
            actual = _dbt_value(vars_, p["dbt"])
        except KeyError:
            found.append(f"{p['id']}: dbt var {p['dbt']} does not exist")
            continue
        if actual != p["value"]:
            found.append(f"{p['id']}: registry {p['value']!r}, dbt {p['dbt']} {actual!r}")
    return found


def render(params: list[dict[str, Any]]) -> str:
    values = {p["id"]: p["value"] for p in params}
    meta = [
        {
            k: p[k]
            for k in ("id", "kind", "status", "what", "evidence", "validation", "dbt")
            if k in p
        }
        | {"value": p["value"]}
        for p in params
    ]
    return (
        "// Generated from methodology/parameters.yml by `uv run python -m ops.parameters`;"
        " do not edit (#765).\n\n"
        "/** Every registered parameter's value, by id. */\n"
        f"export const PARAMS = {json.dumps(values, indent=2)} as const;\n\n"
        "/** Every registered parameter, for the Methodology page. */\n"
        f"export const PARAMETERS = {json.dumps(meta, indent=2)} as const;\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    params = load()
    wrong = problems(params) + dbt_mismatches(params)
    if wrong:
        print("the parameter registry is wrong:", *wrong, sep="\n  ", file=sys.stderr)
        return 1
    text = render(params)
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(
                f"{OUT.relative_to(ROOT)} is stale: run uv run python -m ops.parameters",
                file=sys.stderr,
            )
            return 1
        print(f"{OUT.relative_to(ROOT)} is current ({len(params)} parameters)")
        return 0
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(params)} parameters")
    return 0


if __name__ == "__main__":
    sys.exit(main())
