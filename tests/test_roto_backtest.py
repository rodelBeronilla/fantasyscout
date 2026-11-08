"""The rotisserie rework's judgement keeps to the declared folds (#866): each fold fits on the other
tuning seasons of its league only, the bar is applied fold by fold and pooled, and the spreads'
new part nests the constant one."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ops import roto_backtest as rb
from ops import standings, standings_backtest
from tests.test_standings_backtest import _season


def _params() -> dict[str, object]:
    p = standings.registry()
    p["backtest.standings_leagues"] = 6
    p["backtest.bootstrap"] = 40
    return p


def test_the_part_that_averages_out_falls_with_the_games_left() -> None:
    p = standings.registry()
    flat = standings.spreads(
        "nba", standings.CATS, 10, "roto", 80, p, projection=0.5, projection_games=0
    )
    both = standings.spreads(
        "nba", standings.CATS, 10, "roto", 80, p, projection=0.5, projection_games=4
    )
    late = standings.spreads(
        "nba", standings.CATS, 10, "roto", 10, p, projection=0.5, projection_games=4
    )
    assert (both > flat).all()
    assert ((late**2 - both**2) > 0).all()
    want = np.sqrt(flat**2 + 16 / 80 * 2 * 10)
    assert both == pytest.approx(want)


def test_each_fold_fits_on_the_other_seasons_and_the_bar_is_pooled(tmp_path: Path) -> None:
    seasons = [
        standings_backtest.load(_season(tmp_path / s, "nba", s, weeks=10, seed=k))
        for k, s in enumerate(("2020-21", "2021-22", "2022-23"))
    ]
    res = rb.cv(seasons, _params())
    assert [f["held_out"] for f in res["folds"]] == ["2020-21", "2021-22", "2022-23"]
    assert len(res["pooled"]) == 2
    for f in res["folds"]:
        assert f["fitted"]["projection_spread"] in rb.LASTING
        assert f["fitted"]["projection_spread_games"] in rb.PASSING
        assert (
            f["fitted"]["roto_log_loss"]["model"]
            <= f["fitted"]["roto_log_loss"]["constant"] + 1e-12
        )
    assert res["pass"] == (res["folds_passed"] >= 2 and not res["pooled_fails"])


def test_only_the_tuning_seasons_are_read(tmp_path: Path) -> None:
    season = standings_backtest.load(_season(tmp_path / "s", "nba", "2023-24", weeks=4))
    with pytest.raises(SystemExit, match="not a tuning season"):
        rb.cv([season], _params())


def test_the_bar_needs_the_slope_and_every_baseline() -> None:
    ok = {
        "as_of": "x",
        "slope_model": [1.0, 0.9, 1.1],
        "vs_coin": [0.02, 0.01, 0.03],
        "vs_naive": [0.01, 0.001, 0.02],
        "vs_constant": [0.0, -0.001, 0.001],
    }
    assert rb.passes([ok, ok]) == []
    first = {**ok, "vs_naive": [-0.001, -0.002, 0.001]}  # no worse at the first game day is enough
    assert rb.passes([first, ok]) == []
    assert rb.passes([{**ok, "slope_model": [1.9, 1.7, 2.1]}, ok])
    assert rb.passes([ok, {**ok, "vs_constant": [-0.01, -0.02, -0.005]}])
