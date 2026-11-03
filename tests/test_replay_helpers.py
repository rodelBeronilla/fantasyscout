"""The analysis helpers the notebooks share from notebooks/replay.py (#484)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "notebooks"))
import replay


def test_ols_recovers_a_line_and_weights_rows() -> None:
    x = np.c_[np.ones(4), np.array([0.0, 1.0, 2.0, 3.0])]
    y = np.array([1.0, 3.0, 5.0, 7.0])
    assert replay.ols(x, y) == pytest.approx([1.0, 2.0])
    # a zero weight drops a row: the outlier stops pulling the fit
    y_out = np.array([1.0, 3.0, 5.0, 70.0])
    assert replay.ols(x, y_out, np.array([1.0, 1.0, 1.0, 0.0])) == pytest.approx([1.0, 2.0])


def test_finished_keeps_the_latest_season_only_once_it_has_playoffs() -> None:
    games = pd.DataFrame({"season": ["2023", "2024", "2025"], "regular": [True, True, True]})
    assert replay.finished(games) == ["2023", "2024"]
    with_playoffs = pd.concat([games, pd.DataFrame({"season": ["2025"], "regular": [False]})])
    assert replay.finished(with_playoffs) == ["2023", "2024", "2025"]


def test_value_scale_is_the_pool_spread_and_the_shooting_percentages() -> None:
    rows: list[dict[str, object]] = []
    for pid, pts, fgm, fga in (("a", 10, 4, 8), ("b", 20, 8, 16), ("c", 30, 6, 20)):
        row: dict[str, object] = {c: 0.0 for c in replay.COUNTING}
        row.update(player_id=pid, played=True, minutes=30.0, points=float(pts))
        row.update(fgm=float(fgm), fga=float(fga), ftm=2.0, fta=4.0)
        rows.append(row)
    scale = replay.value_scale(pd.DataFrame(rows), "nba")
    assert scale["points"] == pytest.approx(10.0)  # std of 10, 20, 30
    pct, spread = scale["fg"]
    assert pct == pytest.approx(18 / 44)
    impact = [(m / a - 18 / 44) * a for m, a in ((4, 8), (8, 16), (6, 20))]
    assert spread == pytest.approx(pd.Series(impact).std())
    assert scale["ft"][0] == pytest.approx(0.5)
