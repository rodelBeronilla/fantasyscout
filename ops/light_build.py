"""A light build must not read a model this change adds (#956).

    uv run python -m ops.light_build check --base origin/main   # from the repository root

The evening's light build (`build.yml`) builds only ``SELECT``: the report feeds' models, their
consumers and the ops tables. Every other model on the lakehouse is the one the last full build
left, so a model a change adds does not exist there until a full build creates it. A light build
that reads it fails: after #920 added ``player_birth_dates``, every light build failed at the gate
until a full build ran by hand (#922).

The light build runs no unit tests (``EXCLUDE_RESOURCE_TYPE``): dbt reads a unit test's input
columns off the input's table, which a light build need not have built. A unit test checks the
SQL, which every pull request's CI and every full build run.

``check`` lists the nodes the light build runs (``dbt ls`` with the build's own selection) and
fails when one of them reads a model or seed that this checkout has and ``--base`` lacks, and that
the light build does not build itself. Since a unit test's inputs are refs of the model it tests,
a new model behind a selected model's unit test is caught here too. Exits 1 and names each one.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DBT = ROOT / "dbt"

# What build.yml's light build selects and leaves out (tests/test_light_build.py holds them equal).
SELECT = "tag:feed_reports+ path:models/ops"
EXCLUDE_RESOURCE_TYPE = "unit_test"

# The nodes a build runs (an exposure or a source is only listed).
RUN = {"model", "seed", "snapshot", "test", "unit_test"}
# The nodes a build creates a table for, by the folder that holds their files.
RELATIONS = {"model": ("dbt/models", ".sql"), "seed": ("dbt/seeds", ".csv")}


def relations(paths: Iterable[str]) -> set[str]:
    """The relations (``model.x``, ``seed.x``) the given repository paths define."""
    out: set[str] = set()
    for path in paths:
        p = path.replace("\\", "/")
        for kind, (folder, suffix) in RELATIONS.items():
            if p.startswith(folder + "/") and p.endswith(suffix):
                out.add(f"{kind}.{Path(p).stem}")
    return out


def problems(nodes: list[dict[str, object]], new: set[str]) -> list[tuple[str, str]]:
    """(node, parent) for each node run that reads a new relation the light build does not build."""
    run = [n for n in nodes if n.get("resource_type") in RUN]
    built = {str(n["unique_id"]) for n in run}
    out: list[tuple[str, str]] = []
    for n in run:
        depends = n.get("depends_on")
        parents = depends.get("nodes", []) if isinstance(depends, dict) else []
        for parent in parents:
            kind, _, name = str(parent).partition(".")
            relation = f"{kind}.{name.partition('.')[2]}"
            if parent not in built and relation in new:
                out.append((str(n["unique_id"]), str(parent)))
    return sorted(set(out))


def _git_paths(ref: str) -> list[str]:
    proc = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", ref, "--", "dbt/models", "dbt/seeds"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.split()


def _checkout_paths() -> list[str]:
    return [
        p.relative_to(ROOT).as_posix()
        for folder in ("dbt/models", "dbt/seeds")
        for p in (ROOT / folder).rglob("*")
        if p.is_file()
    ]


def _light_nodes() -> list[dict[str, object]]:
    args = ["dbt", "ls", "-q", "--select", SELECT, "--exclude-resource-type", EXCLUDE_RESOURCE_TYPE]
    args += ["--output", "json", "--output-keys", "unique_id resource_type depends_on"]
    proc = subprocess.run(
        args,
        cwd=DBT,
        env={**os.environ, "DBT_PROFILES_DIR": "."},
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        sys.exit(f"dbt ls failed:\n{proc.stdout}\n{proc.stderr}")
    return [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="fail when a light build reads a model this change adds")
    check.add_argument("--base", default="origin/main", help="the commit to compare with")
    args = parser.parse_args(argv)

    new = relations(_checkout_paths()) - relations(_git_paths(args.base))
    found = problems(_light_nodes(), new)
    print(f"new relations against {args.base}: {', '.join(sorted(new)) or 'none'}")
    for node, parent in found:
        print(
            f"::error::the light build runs {node}, which reads {parent}; this change adds it, "
            "and the lakehouse has no table for it until a full build makes one"
        )
    if found:
        print(
            "Merge the new model on its own first and run one full build (Build lakehouse by "
            "hand), then the change that reads it (docs/runbook.md, 'Build the lakehouse by hand')."
        )
        return 1
    print("the light build reads no relation this change adds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
