"""The rework's folds (#900) keep to the tuning seasons, refit in each fold on the others alone, and
apply #872's bar per fold and pooled."""

from __future__ import annotations

from pathlib import Path

import pytest

from ops import playoff_cv
from ops.standings_backtest import SCALES
from tests.test_playoff_backtest import _params
from tests.test_standings_backtest import _season


def test_the_folds_read_only_the_tuning_seasons(tmp_path: Path) -> None:
    folder = _season(tmp_path / "s", "nba", "2023-24", weeks=14)
    with pytest.raises(SystemExit, match="not a tuning season"):
        playoff_cv.cv([folder], _params(), workers=1)


def test_one_fold_per_season_each_fitted_on_the_others(tmp_path: Path) -> None:
    folders = [
        _season(tmp_path / s, "nba", s, weeks=14, seed=i)
        for i, s in enumerate(("2020-21", "2021-22", "2022-23"), 1)
    ]
    p = _params()
    res = playoff_cv.cv(folders, p, workers=2)
    assert [f["held_out"] for f in res["folds"]] == ["2020-21", "2021-22", "2022-23"]
    for f in res["folds"]:
        fitted = f["fitted"]
        assert fitted["scale"] in SCALES
        assert set(fitted["share"]) == set(playoff_cv.TALLIES)
        assert all(s in playoff_cv.SHARES for s in fitted["share"].values())
        assert fitted["one_share"] in playoff_cv.SHARES
        for cp in f["checkpoints"]:
            for t in playoff_cv.TALLIES:
                assert cp[t]["brier_vs_coin"][1] <= cp[t]["brier_vs_coin"][0]
    assert len(res["pooled"]) == 2
    assert res["pass"] == (res["folds_passed"] >= 2 and not res["pooled_fails"])
    # what would ship: the same rule on all three seasons
    shipped = playoff_cv.fit(folders, p, workers=2)["nba"]
    assert shipped["seasons"] == ["2020-21", "2021-22", "2022-23"]
    assert set(shipped["share"]) == set(playoff_cv.TALLIES)
