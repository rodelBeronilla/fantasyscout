"""The ML challenger's margin is the declared one, and it runs end to end on a small grid (#771)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ops import projection_challenger as ch
from ops import projection_features as pf
from tests.test_projection_features import _parts


def _gap(off: float, gap: float, high: float, as_of: str = "x") -> pf.Gap:
    return pf.Gap(as_of, 100, 100, off, off + gap, gap, gap - 0.01, high, *([0.0] * 10))


def test_it_ships_only_past_the_margin_with_the_interval_below_zero() -> None:
    per = [_gap(1.0, -0.05, -0.01)]
    assert ch.ships(per, _gap(1.0, -0.05, -0.01))[0]
    # 2% better is not the 3% declared
    assert not ch.ships(per, _gap(1.0, -0.02, -0.01))[0]
    # an interval reaching zero does not ship
    assert not ch.ships(per, _gap(1.0, -0.05, 0.001))[0]
    # nor a checkpoint worse past the tolerance
    assert not ch.ships([*per, _gap(1.0, 0.02, 0.03)], _gap(1.0, -0.05, -0.01))[0]


def _cut(season: str, n: int, seed: int) -> pf.Cut:
    rng = np.random.default_rng(seed)
    df = pd.DataFrame(
        {
            "age": rng.uniform(20, 35, n),
            "is_rookie": rng.integers(0, 2, n).astype(bool),
            "team_id": "A",
            "prev_team_id": rng.choice(["A", "B"], n),
            "proj_minutes_season_pg": rng.uniform(10, 35, n),
            "minutes_last5_pg": rng.uniform(10, 35, n),
            "games_share": rng.uniform(0.5, 1, n),
            "absence_games": np.nan,
            "games_since_return": np.nan,
        }
    )
    parts = _parts(n, seed)
    df = pd.concat([parts, df], axis=1)
    for k in (1, 2, 3):
        df[f"s{k}_games"] = rng.integers(0, 82, n)
        df[f"s{k}_minutes_pg"] = rng.uniform(5, 36, n)
        for c in pf.PRODUCTION:
            df[f"s{k}_{c}_pg"] = rng.uniform(0, 10, n)
    scale = {c: 1.0 for c in pf.SCALE_COLUMNS} | {"pool": 20.0}
    line = pf.lines(df, pf.NEUTRAL)
    for c in pf.PRODUCTION:
        df[f"real_{c}_pg"] = line[c] * rng.uniform(0.8, 1.2, n)
    real = pf.total(pf.score(pf.realized_line(df), scale))
    return pf.Cut(season, 0.0, df, scale, real, 20)


def test_the_challenger_runs_through_the_checkpoints() -> None:
    pytest.importorskip("sklearn")
    tuning = [_cut(s, 80, i) for i, s in enumerate(("2020-21", "2021-22", "2022-23"))]
    judged = [_cut("2023-24", 80, 9)]
    grid = [
        {
            "learning_rate": 0.1,
            "max_leaf_nodes": 7,
            "min_samples_leaf": 20,
            "max_iter": 20,
            "l2_regularization": 0.0,
        }
    ]
    results = ch.run(tuning, judged, pf.NEUTRAL, resamples=20, grid=grid)
    assert [r.variant for r in results] == list(ch.VARIANTS)
    assert all(r.pooled.players == 80 and np.isfinite(r.pooled.rmse_gap) for r in results)
