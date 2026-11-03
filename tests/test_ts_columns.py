"""The committed web/src/generated/columns.ts is export.ts_columns' output (#479)."""

from __future__ import annotations

from export import layout
from export.ts_columns import OUT, render


def test_the_generated_columns_are_current() -> None:
    assert OUT.read_text(encoding="utf-8") == render(), "run `uv run python -m export.ts_columns`"


def test_every_board_column_is_in_its_union() -> None:
    text = render()
    for c in layout.BOARD_COLUMNS:
        assert f"  | '{c}'" in text
