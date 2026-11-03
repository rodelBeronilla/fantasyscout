"""Every command the runbook names exists and its arguments parse (#416).

The runbook's ``uv run`` commands, in fenced blocks and inline code, are parsed by the real
argument parser of the program they name, and stopped right after parsing, so nothing runs: an
unknown subcommand or flag fails here instead of in the middle of an incident.
"""

from __future__ import annotations

import argparse
import importlib
import re
import shlex
from collections.abc import Sequence
from pathlib import Path
from typing import NoReturn

import pytest

ROOT = Path(__file__).resolve().parent.parent
RUNBOOK = ROOT / "docs" / "runbook.md"
SCRIPTS = {"fs-ingest": "ingest.cli", "fs-export": "export.cli", "fs-dev": "ops.dev"}
# A placeholder stands for one of these; one the parser constrains gets a valid choice.
PLACEHOLDERS = {"source": "stats", "league": "nba", "date": "2026-10-01", "id": "x", "run_id": "x"}


def runbook_commands() -> list[str]:
    text = RUNBOOK.read_text(encoding="utf-8")
    found: list[str] = []
    for block in re.findall(r"^[ \t]*```[a-z]*\n(.*?)^[ \t]*```", text, flags=re.S | re.M):
        found += [line.strip() for line in block.splitlines() if line.strip().startswith("uv run ")]
    found += re.findall(r"`(uv run [^`]+)`", text)
    return sorted(set(found))


def _argv(command: str) -> tuple[str, list[str]]:
    """The module whose main parses the command, and its arguments (shell bits made concrete)."""
    command = re.sub(r"\s+#.*$", "", command)  # a trailing comment
    command = re.sub(r"\[([^\]]+)\]", r"\1", command)  # [--optional parts] are written out
    command = re.sub(r"<([a-z_ ]+)>", lambda m: PLACEHOLDERS.get(m.group(1), "x"), command)
    command = command.replace('"$season"', "2025").replace("$season", "2025")
    words = shlex.split(command)[2:]  # past "uv run"
    while words and words[0].startswith("--"):  # uv's own flags, e.g. --with tzdata
        words = words[2:] if words[0] in ("--with", "--group") else words[1:]
    if words[:2] == ["python", "-m"]:
        return words[2], words[3:]
    return SCRIPTS[words[0]], words[1:]


class _ParsedError(Exception):
    pass


COMMANDS = runbook_commands()


def test_the_runbook_names_commands() -> None:
    assert len(COMMANDS) >= 10


@pytest.mark.parametrize("command", COMMANDS)
def test_a_runbook_command_parses(command: str, monkeypatch: pytest.MonkeyPatch) -> None:
    module_name, args = _argv(command)
    module = importlib.import_module(module_name)
    real = argparse.ArgumentParser.parse_args

    def parse_then_stop(
        self: argparse.ArgumentParser,
        args: Sequence[str] | None = None,
        namespace: argparse.Namespace | None = None,
    ) -> NoReturn:
        real(self, args, namespace)  # an unknown subcommand or flag exits here with status 2
        raise _ParsedError

    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", parse_then_stop)
    with pytest.raises(_ParsedError):
        module.main(args)
