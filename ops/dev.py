"""``fs-dev check``: the checks CI runs, in CI's order, from one command.

The Python job of ``.github/workflows/ci.yml`` runs exactly ``uv run fs-dev check``; what it does is
written here once, so the README's quoted command and CI cannot drift. ``--web`` and ``--worker``
add the two Node suites (CI runs those in their own jobs); ``--list`` prints the steps and runs
nothing.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Step:
    name: str
    command: list[str]
    cwd: str = "."
    env: dict[str, str] = field(default_factory=dict)
    group: str = "python"

    @property
    def text(self) -> str:
        prefix = "".join(f"{k}={v} " for k, v in self.env.items())
        where = f"(in {self.cwd}) " if self.cwd != "." else ""
        return f"{where}{prefix}{' '.join(self.command)}"


def tool(name: str) -> str:
    """A console script of the environment fs-dev runs in.

    ``uv run`` puts them beside the interpreter; a name not found there is left to PATH."""
    found = shutil.which(name, path=str(Path(sys.executable).parent))
    return found or name


STEPS: tuple[Step, ...] = (
    Step("ruff check", [tool("ruff"), "check", "."]),
    Step("ruff format", [tool("ruff"), "format", "--check", "."]),
    Step("mypy", [tool("mypy")]),
    Step("the dbt sample's landing files", [sys.executable, "dbt/sample/build_sample.py"]),
    Step(
        "dbt build on DuckDB (the sample; data checks excluded)",
        [tool("dbt"), "build", "--target", "duckdb", "--exclude", "tag:quality"],
        cwd="dbt",
        env={"DBT_PROFILES_DIR": "."},
    ),
    Step("pytest", [tool("pytest")]),
    Step("web: install", ["npm", "ci"], cwd="web", group="web"),
    Step("web: astro check", ["npm", "run", "check"], cwd="web", group="web"),
    Step("web: eslint", ["npm", "run", "lint"], cwd="web", group="web"),
    Step("web: vitest", ["npm", "run", "test:unit"], cwd="web", group="web"),
    Step(
        "web: build",
        ["npm", "run", "build"],
        cwd="web",
        env={"PUBLIC_BUILD_ID": "local"},
        group="web",
    ),
    Step("web: playwright", ["npm", "test"], cwd="web", group="web"),
    Step("worker: install", ["npm", "ci"], cwd="worker", group="worker"),
    Step("worker: typecheck", ["npm", "run", "typecheck"], cwd="worker", group="worker"),
    Step("worker: vitest (workerd)", ["npm", "test"], cwd="worker", group="worker"),
    Step("worker: wrangler dry run", ["npm", "run", "check"], cwd="worker", group="worker"),
)


def steps_for(groups: set[str]) -> list[Step]:
    return [s for s in STEPS if s.group in groups]


def run(step: Step) -> int:
    """Run one step, streaming its output; returns its exit code."""
    command = list(step.command)
    if command[0] == "npm" and os.name == "nt":  # npm is a .cmd shim on Windows
        command[0] = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
    env = {**os.environ, **step.env}
    started = time.monotonic()
    print(f"::group::{step.name}  ({step.text})", flush=True)
    try:
        code = subprocess.run(command, cwd=ROOT / step.cwd, env=env, check=False).returncode
    except FileNotFoundError as exc:
        print(f"{step.name}: {exc}", file=sys.stderr)
        code = 127
    print("::endgroup::", flush=True)
    verdict = "ok" if code == 0 else f"FAILED (exit {code})"
    print(f"{step.name}: {verdict} in {time.monotonic() - started:.0f}s", flush=True)
    return code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fs-dev", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="run the checks CI runs")
    check.add_argument(
        "--web",
        action="store_true",
        help="add the web suite (astro check, eslint, vitest, build, Playwright)",
    )
    check.add_argument(
        "--worker",
        action="store_true",
        help="add the Worker suite (typecheck, vitest in workerd, wrangler dry run)",
    )
    check.add_argument("--all", action="store_true", help="every suite")
    check.add_argument("--list", action="store_true", help="print the steps and run nothing")
    check.add_argument(
        "--keep-going", action="store_true", help="run every step even after a failure"
    )
    args = parser.parse_args(argv)

    groups = {"python"}
    if args.web or args.all:
        groups.add("web")
    if args.worker or args.all:
        groups.add("worker")
    chosen = steps_for(groups)
    if args.list:
        for step in chosen:
            print(f"{step.group:7} {step.name}: {step.text}")
        return 0
    failed: list[str] = []
    for step in chosen:
        if run(step) != 0:
            failed.append(step.name)
            if not args.keep_going:
                break
    if failed:
        print(f"\nfs-dev check: {len(failed)} step(s) failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"\nfs-dev check: {len(chosen)} steps ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
