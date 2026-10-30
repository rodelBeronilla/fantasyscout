"""Write the analysis notebooks as .ipynb files (run once; the notebooks are committed).

    uv run python notebooks/make_notebooks.py

Keeping the source here, as plain Python strings, makes the notebooks reviewable in a diff and
regenerable; nbconvert executes the committed .ipynb files in CI and after every export. Every
notebook covers both leagues and ends by saving its headline findings (``fs.save_findings``),
which the site's Notebooks page shows per league next to the link to the rendered notebook. A
league this build cannot answer for yet is saved with ``fs.insufficient``, which the page shows
as accumulating rather than as zeros.

The cell sources live in one module per notebook (``nb_*.py`` beside this file), each a list of
(kind, source) pairs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from nb_board_backtest import CELLS as BOARD_BACKTEST  # noqa: E402
from nb_data_quality import CELLS as DATA_QUALITY  # noqa: E402
from nb_game_context import CELLS as GAME_CONTEXT  # noqa: E402
from nb_shooting import CELLS as SHOOTING  # noqa: E402
from nb_streamer_signals import CELLS as STREAMER_SIGNALS  # noqa: E402

NOTEBOOKS: dict[str, list[tuple[str, str]]] = {
    "01_board_backtest": BOARD_BACKTEST,
    "02_streamer_signals": STREAMER_SIGNALS,
    "03_game_context": GAME_CONTEXT,
    "04_data_quality": DATA_QUALITY,
    "05_shooting": SHOOTING,
}


def main() -> None:
    for old in HERE.glob("*.ipynb"):
        if old.stem not in NOTEBOOKS:
            old.unlink()
            print("removed", old.name)
    for name, cells in NOTEBOOKS.items():
        nb = nbf.v4.new_notebook()
        nb.metadata["kernelspec"] = {
            "name": "python3",
            "display_name": "Python 3",
            "language": "python",
        }
        nb.cells = [
            nbf.v4.new_markdown_cell(src) if kind == "md" else nbf.v4.new_code_cell(src)
            for kind, src in cells
        ]
        path = HERE / f"{name}.ipynb"
        nbf.write(nb, path)
        print("wrote", path.name, len(nb.cells), "cells")


if __name__ == "__main__":
    main()
