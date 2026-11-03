"""Every column the export ships to the pages is read by one of them (#463).

The board, streamers and player files carry the columns named in ``export/layout.py``. A column no
component reads is bytes every visitor downloads for nothing, and the layout's promise that the
pages read every one of them goes stale. This test looks for each name in the web source, outside
the type declarations (a field in an interface is not a read). The Board builds its windowed
z-score names from a prefix (``season_``, ``last20_``, ``recent_``), so those count when the prefix
does.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from export import layout

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web" / "src"
LISTS = (
    "BOARD_COLUMNS",
    "STREAMER_COLUMNS",
    "PLAYER_BOARD_COLUMNS",
    "PLAYER_ROLLING_COLUMNS",
    "PLAYER_ZSCORE_COLUMNS",
)
# Prefixes a component joins to a category name instead of spelling the column out.
PREFIXES = ("season_", "last20_", "recent_", "proj_", "last_10_")

_INTERFACE = re.compile(r"(?:export\s+)?interface\s+\w+[^{]*\{(?:[^{}]|\{[^{}]*\})*\}", re.S)
_TYPE = re.compile(r"(?:export\s+)?type\s+\w+\s*=\s*\{(?:[^{}]|\{[^{}]*\})*\};?", re.S)


def _source() -> str:
    parts = []
    for path in sorted(WEB.rglob("*")):
        if path.suffix not in (".ts", ".tsx", ".astro") or "generated" in path.parts:
            continue
        if path.name.endswith(".test.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        parts.append(_TYPE.sub("", _INTERFACE.sub("", text)))
    return "\n".join(parts)


SOURCE = _source()


def _name(column: str) -> str:
    """The output name of a layout entry: a bare column, or the alias of an expression."""
    match = re.search(r"([A-Za-z_0-9]+)\s*$", column.strip())
    assert match, column
    return match.group(1)


def _read(name: str) -> bool:
    if re.search(rf"\b{re.escape(name)}\b", SOURCE):
        return True
    return any(
        name.startswith(prefix) and (f"'{prefix}'" in SOURCE or f"`{prefix}${{" in SOURCE)
        for prefix in PREFIXES
    )


@pytest.mark.parametrize("list_name", LISTS)
def test_every_exported_column_is_read_by_a_page(list_name: str) -> None:
    columns = [_name(c) for c in getattr(layout, list_name)]
    unread = [c for c in columns if not _read(c)]
    assert not unread, f"{list_name}: no page reads {unread}; show them or drop them"


def test_a_column_only_declared_in_a_type_does_not_count() -> None:
    assert "interface" not in _INTERFACE.sub("", "interface Row {\n  only_here: number;\n}\n")
