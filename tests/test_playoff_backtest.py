"""The playoff odds' backtest scores and judges as declared on #872, and keeps to its seasons: the
fit reads only the tuning seasons, the judgement refuses the locked one."""

from __future__ import annotations

from pathlib import Path

import pytest

from ops import playoff_backtest as pb
from ops import standings
from tests.test_standings_backtest import _season


def _params(**over: object) -> dict[str, object]:
    p = standings.registry()
    p["backtest.standings_leagues"] = 6
    p["backtest.bootstrap"] = 40
    p["playoffs.simulations"] = 200
    return {**p, **over}


def test_a_board_that_knows_the_players_beats_the_coin(tmp_path: Path) -> None:
    season = pb.load(_season(tmp_path / "s", "nba", "2023-24", weeks=14))
    res = pb.judge(season, _params())
    later = res["checkpoints"][1]
    assert later["weeks_left"] > 0
    for tally in pb.TALLIES:
        assert later[tally]["brier_vs_coin"][0] > 0
        # the odds share out the playoff places
        assert later[tally]["made_share"] == pytest.approx(6 / 12)


def test_the_first_game_day_starts_level(tmp_path: Path) -> None:
    season = pb.load(_season(tmp_path / "s", "nba", "2023-24", weeks=14))
    figs = pb.checkpoint(season.cuts[0], season.weeks, _params(), "nba", 0.0)
    for f in figs.values():
        assert (f.naive == 0.5).all()
        assert f.so_far[0].sum() == 0


def test_the_verdict_applies_the_declared_bar() -> None:
    ok = {
        "brier_vs_coin": [0.02, 0.01, 0.03],
        "brier_vs_naive": [0.01, 0.002, 0.02],
        "slope": [1.0, 0.8, 1.2],
    }
    first = {**ok, "brier_vs_naive": [0.0, 0.0, 0.0]}  # the naive manager is the coin there
    res = {
        "checkpoints": [
            {"as_of": "a", **dict.fromkeys(pb.TALLIES, first)},
            {"as_of": "b", **dict.fromkeys(pb.TALLIES, ok)},
        ]
    }
    assert pb.verdict(res) == []
    bad = {**ok, "slope": [0.6, 0.5, 0.7]}
    res["checkpoints"][1]["matchups"] = bad
    assert pb.verdict(res) == ["matchups b: calibration slope 0.600 outside (0.8, 1.25)"]


def test_the_fit_reads_only_the_tuning_seasons(tmp_path: Path) -> None:
    season = pb.load(_season(tmp_path / "s", "nba", "2023-24", weeks=14))
    with pytest.raises(SystemExit, match="not a tuning season"):
        pb.fit([season], _params())


def test_the_held_out_season_is_refused(tmp_path: Path) -> None:
    folder = _season(tmp_path / "s", "nba", "2025-26", weeks=14)
    assert pb.main(["judge", str(folder)]) == 2
