"""The market prior's fit reads only the tuning seasons and applies the rule declared on #832."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ops import market_prior_fit
from ops.market_prior_fit import Point, pick


def _players(season: str, rng: np.random.Generator) -> pd.DataFrame:
    # the market knows the realized order; the board is noisy
    real = np.linspace(-2, 3, 40)
    rows = [
        pd.DataFrame(
            {
                "league": "nba",
                "season": season,
                "checkpoint": checkpoint,
                "player_id": [f"p{i}" for i in range(40)],
                "board_value": real + rng.normal(0, 1.5, 40),
                "market_prior_value": real,
                "market_prior_games": games,
                "realized_value": real,
                "realized_games": 20,
            }
        )
        for checkpoint, games in ((0.0, 0), (0.1, 6), (0.25, 20))
    ]
    return pd.concat(rows)


def test_a_good_market_is_given_weight(tmp_path: Path) -> None:
    rng = np.random.default_rng(1)
    paths = []
    for season in ("2020-21", "2021-22", "2022-23"):
        path = tmp_path / f"{season}.csv"
        _players(season, rng).to_csv(path, index=False)
        paths.append(path)
    cuts = market_prior_fit.load(paths, min_games=10)
    assert len(cuts) == 6, "the first-game-day and tenth checkpoints of three seasons"
    best = pick([market_prior_fit.score(cuts, w, f) for w in (0.0, 0.5, 1.0) for f in (1, 8)])
    assert best.weight == 1.0 and best.fade_games == 8


def test_a_judged_season_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "judged.csv"
    _players("2023-24", np.random.default_rng(0)).to_csv(path, index=False)
    with pytest.raises(SystemExit):
        market_prior_fit.load([path], min_games=10)


def test_ties_go_to_the_smaller_weight_then_the_faster_fade() -> None:
    points = [
        Point(0.5, 3, 0.9, -0.1),
        Point(0.2, 8, 0.9, -0.1),
        Point(0.2, 3, 0.9, -0.1),
        Point(0.9, 1, 0.95, 0.01),  # better ranking, worse RMSE somewhere: not allowed
    ]
    assert pick(points) == Point(0.2, 3, 0.9, -0.1)
