"""The standings model's backtest drafts, scores and judges as declared on #755, and keeps to its
seasons: the fit reads only the tuning seasons, the judgement refuses the locked one."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ops import standings, standings_backtest
from ops.standings import CATS
from ops.standings_backtest import (
    STATS,
    beat,
    cat_values,
    draft,
    fit,
    judge,
    load,
    spearman_rows,
    verdict,
)

# per-game means and spreads of the eleven box-score numbers, a rough NBA regular
MEAN = np.array([14.0, 5.5, 3.2, 0.9, 0.6, 1.6, 1.7, 5.2, 11.0, 2.4, 3.0])
SPREAD = np.array([6.0, 2.5, 2.0, 0.4, 0.5, 0.9, 0.8, 2.2, 4.0, 1.5, 1.8])


def _season(
    folder: Path, league: str, season: str, *, players: int = 260, weeks: int = 12, seed: int = 1
) -> Path:
    """A fake season the way ops.walk_forward hands it over: each player's true per-game line, a
    board that knows it up to a little noise, and weekly box scores drawn from it."""
    rng = np.random.default_rng(seed)
    true = np.clip(MEAN * (1 + 0.6 * rng.standard_normal((players, len(MEAN)))), 0.05, None)
    true[:, 7] = np.minimum(true[:, 7], true[:, 8] * 0.6)
    true[:, 9] = np.minimum(true[:, 9], true[:, 10] * 0.9)

    def z(line: np.ndarray) -> np.ndarray:
        counts = (line[:, :7] - MEAN[:7]) / SPREAD[:7]
        counts[:, 6] *= -1
        fg = (line[:, 7] - 0.47 * line[:, 8]) / 1.5
        ft = (line[:, 9] - 0.78 * line[:, 10]) / 1.0
        return np.column_stack([counts, fg, ft])

    first = date(2024, 10, 21)
    folder.mkdir(parents=True)
    cuts = [first, first + timedelta(days=28)]
    (folder / "meta.json").write_text(
        json.dumps(
            {"league": league, "season": season, "checkpoints": [d.isoformat() for d in cuts]}
        )
    )
    rows = []
    for w in range(weeks):
        games = rng.integers(2, 5, players)
        for pid in range(players):
            line = rng.poisson(true[pid] * games[pid])
            line[7] = min(line[7], line[8])
            line[9] = min(line[9], line[10])
            rows.append(
                {
                    "player_id": f"p{pid}",
                    "week": first + timedelta(weeks=w),
                    "games": games[pid],
                    **dict(zip(STATS, line, strict=True)),
                }
            )
    pd.DataFrame(rows).to_csv(folder / "weeks.csv", index=False)
    for cut in cuts:
        board = z(true * (1 + 0.1 * rng.standard_normal(true.shape)))
        naive = z(true * (1 + 0.4 * rng.standard_normal(true.shape)))
        df = pd.DataFrame(board, columns=list(CATS))
        df.insert(0, "player_id", [f"p{i}" for i in range(players)])
        df["availability_multiplier"] = 1.0
        df["games_share"] = 1.0
        df["ros_factor"] = 1.0
        df["value_rest_of_season"] = board.sum(1)
        df["games_remaining"] = 40
        df["adp_rank"] = (
            np.argsort(np.argsort(-(board.sum(1) + rng.standard_normal(players)))) + 1.0
        )
        for k, c in enumerate(CATS):
            df[f"naive_{c}"] = naive[:, k]
        df.to_csv(folder / f"players-{cut.isoformat()}.csv", index=False)
    return folder


def _params(leagues: int = 20) -> dict[str, object]:
    p = standings.registry()
    p["backtest.standings_leagues"] = leagues
    p["backtest.bootstrap"] = 60
    return p


def test_a_draft_fills_every_roster_with_different_players() -> None:
    value = np.arange(100, dtype=float)
    rost = draft(np.random.default_rng(0), value, leagues=3, teams=4, spots=5, choice=1)
    assert rost.shape == (3, 4, 5)
    for lg in rost:
        assert len(set(lg.ravel())) == 20, "no player twice in a league"
    # with no randomness it is a snake: the first pick is the best, the eighth goes to team 1 again
    assert (
        rost[0, 0, 0] == 99 and rost[0, 3, 0] == 96 and rost[0, 3, 1] == 95 and rost[0, 0, 1] == 92
    )


def test_turnovers_are_won_with_fewer_and_percentages_by_makes_over_attempts() -> None:
    a = np.array([10, 5, 3, 1, 1, 2, 4, 5, 10, 1, 2], dtype=float)
    b = np.array([10, 4, 3, 2, 1, 2, 2, 10, 20, 0, 0], dtype=float)
    won = beat(cat_values(a), cat_values(b))
    assert list(won) == [0.5, 1, 0.5, 0, 0.5, 0.5, 0, 0.5, 1], (
        "a tie counts half; no attempts loses"
    )


def test_spearman_shares_tied_ranks() -> None:
    a = np.array([[1.0, 2.0, 3.0, 4.0]])
    assert spearman_rows(a, a)[0] == pytest.approx(1)
    assert spearman_rows(a, -a)[0] == pytest.approx(-1)
    assert np.isnan(spearman_rows(a, np.ones((1, 4)))[0])


def test_a_board_that_knows_the_players_beats_the_coin_and_the_naive_manager(
    tmp_path: Path,
) -> None:
    season = load(_season(tmp_path / "s", "nba", "2023-24"))
    res = judge(season, _params())
    for cp in res["checkpoints"]:
        for fmt in ("h2h", "roto"):
            r = cp[fmt]
            assert r["brier"]["model"] < r["brier"]["coin"]
            assert r["brier_vs_naive"][0] > 0, (
                "a sharper board is better calibrated than a noisier one"
            )
            assert r["spearman"]["model"][0] > r["spearman"]["naive"][0]
            assert r["slope"][1] <= r["slope"][0] <= r["slope"][2] or fmt == "roto"
            assert set(r["fit"]) == {"fit", "value", "thirds", "naive", "market"}
    assert set(res["fit_pooled"]["h2h"]) == {"value", "thirds", "naive", "market"}
    assert isinstance(verdict(res), list)


def test_the_verdict_applies_the_declared_bar() -> None:
    good = {
        "brier_vs_coin": [0.01, 0.005, 0.02],
        "brier_vs_naive": [0.01, 0.002, 0.02],
        "slope": [1.0, 0.9, 1.1],
        "spearman": {"model": [0.5, 0.4, 0.6]},
        "spearman_vs_naive": [0.05, 0.01, 0.09],
    }
    first = {
        **good,
        "brier_vs_naive": [-0.001, -0.004, 0.002],
        "spearman_vs_naive": [0.0, -0.02, 0.02],
    }
    later = {**good, "slope": [1.3, 1.2, 1.4]}
    res = {
        "checkpoints": [
            {"as_of": "a", "h2h": first, "roto": first},
            {"as_of": "b", "h2h": later, "roto": good},
        ],
        "fit_pooled": {
            "h2h": {
                "value": [0.01, 0.001, 0.02],
                "naive": [0.01, 0.001, 0.02],
                "thirds": [-0.001, -0.01, 0.001],
            },
            "roto": {
                "value": [0.01, -0.001, 0.02],
                "naive": [0.01, 0.001, 0.02],
                "thirds": [0.0, -0.01, 0.01],
            },
        },
    }
    fails = verdict(res)
    assert len(fails) == 2, "no worse than the naive manager is enough at the first game day"
    assert "slope" in fails[0] and "h2h b" in fails[0]
    assert fails[1].startswith("roto Fit vs value")


def test_the_fit_reads_only_the_tuning_seasons(tmp_path: Path) -> None:
    judged = load(_season(tmp_path / "j", "nba", "2023-24", weeks=4, players=200))
    with pytest.raises(SystemExit, match="not a tuning season"):
        fit([judged], _params(4))


def test_the_fit_finds_a_scale_from_the_grid(tmp_path: Path) -> None:
    tuning = load(_season(tmp_path / "t", "nba", "2021-22", weeks=6, players=200))
    res = fit([tuning], _params(8))
    assert res["spread_scale"] in standings_backtest.SCALES
    assert res["h2h_log_loss"]["at_pick"] <= res["h2h_log_loss"]["at_1"]
    assert res["projection_spread"] in standings_backtest.PROJECTIONS


def test_the_held_out_season_is_refused(tmp_path: Path) -> None:
    folder = _season(tmp_path / "l", "nba", "2025-26", weeks=2, players=200)
    assert standings_backtest.main(["judge", str(folder)]) == 2


def test_the_calibration_slope_is_recovered_and_survives_a_near_separation() -> None:
    rng = np.random.default_rng(3)
    x = rng.normal(0, 2, 20_000)
    y = (rng.uniform(size=x.size) < 1 / (1 + np.exp(-0.7 * x))).astype(float)
    assert standings_backtest.logistic_slope(x, y) == pytest.approx(0.7, abs=0.05)
    # nearly every outcome follows the sign: a plain Newton step overshoots and fails here
    y = np.where(x > 0, 1.0, 0.0)
    y[:3] = 0.5
    assert standings_backtest.logistic_slope(x * 10, y) > 1
