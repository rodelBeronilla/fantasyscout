"""Buy low, sell high's backtest (#758) applies the web's lists (ops/buy_sell.py) over arrays,
scores what happened, and keeps to its seasons: the fit reads only the tuning seasons' caches."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from ops import buy_sell, buy_sell_backtest, standings
from ops.buy_sell_backtest import RECENT, boards, fit, judge, lists, verdict
from ops.standings import CATS
from ops.standings_backtest import _seed, load, simulate
from tests.test_standings_backtest import _season


def _p(**over: Any) -> dict[str, Any]:
    p = standings.registry()
    p["backtest.standings_leagues"] = 4
    p["backtest.bootstrap"] = 40
    p.update(over)
    return p


@pytest.fixture(scope="module")
def season(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """A fake season with the buy-sell export and walk_forward's realized values: last ten is
    the truth plus noise, the board the truth plus less."""
    root = tmp_path_factory.mktemp("bs")
    folder = _season(root / "s", "nba", "2023-24", players=200, weeks=8)
    rng = np.random.default_rng(9)
    real = []
    for f in sorted(folder.glob("players-*.csv")):
        as_of = f.stem.removeprefix("players-")
        df = pd.read_csv(f, dtype={"player_id": str})
        z = df[list(CATS)].to_numpy()
        recent = z + rng.normal(0, 0.5, z.shape)
        recent[rng.uniform(size=z.shape) < 0.05] = np.nan
        extra = pd.DataFrame(recent, columns=list(RECENT))
        extra.insert(0, "player_id", df["player_id"])
        extra["injury_group"] = ["out" if u < 0.1 else None for u in rng.uniform(size=len(df))]
        extra["market_prior_weight"] = np.where(rng.uniform(size=len(df)) < 0.3, 0.4, 0.0)
        extra["market_prior_value"] = z.sum(axis=1) + rng.normal(0, 1, len(df))
        extra.to_csv(folder / f"buysell-{as_of}.csv", index=False)
        real.append(
            pd.DataFrame(
                {
                    "player_id": df["player_id"],
                    "as_of": as_of,
                    "realized_value": z.sum(axis=1) + rng.normal(0, 1, len(df)),
                    "realized_games": rng.integers(0, 40, len(df)),
                }
            )
        )
    csv = root / "walk_forward_players.csv"
    pd.concat(real).to_csv(csv, index=False)
    return folder, csv


def test_the_array_lists_are_the_webs(season: tuple[Path, Path]) -> None:
    folder, csv = season
    p = _p()
    s = load(folder)
    board = boards(s, folder, csv, 10)[1]
    cut = s.cuts[1]
    rost = simulate(cut, p, "nba", _seed(cut.as_of)).rost[0]
    swing = 1.0
    got = lists(rost, board.projected, board.recent, board.healthy, swing)
    want: dict[str, list[int]] = {"buy": [], "sell": []}
    owner = [(str(int(i)), t) for t in range(len(rost)) for i in rost[t]]
    for t in range(len(rost)):
        line = buy_sell.median([float(board.projected[int(i)]) for i in rost[t]])
        out = buy_sell.buy_sell(
            "nba",
            t,
            owner,
            lambda i: float(board.projected[int(i)]),
            lambda i: float(board.recent[int(i)]),
            lambda i: bool(board.healthy[int(i)]),
            line,
            p,
            min_swing=swing,
        )
        want["buy"] += [int(r["id"]) for r in out["buyLow"]]
        want["sell"] += [int(r["id"]) for r in out["sellHigh"]]
    assert got == want
    assert got["buy"] and got["sell"]


def test_the_board_reads_the_webs_values(season: tuple[Path, Path]) -> None:
    folder, csv = season
    s = load(folder)
    b = boards(s, folder, csv, 10)[0]
    extra = pd.read_csv(folder / f"buysell-{s.cuts[0].as_of.isoformat()}.csv")
    z = s.cuts[0].z
    rec = extra[list(RECENT)].to_numpy()
    # a category with no last-ten line keeps the projection's (recentForm)
    assert np.allclose(b.recent, np.where(np.isfinite(rec), rec, z).sum(1))
    w = extra["market_prior_weight"].to_numpy()
    shift = np.where(w > 0, w * (extra["market_prior_value"].to_numpy() - z.sum(1)), 0)
    assert np.allclose(b.projected, z.sum(1) + shift)
    assert not b.healthy[extra["injury_group"].eq("out").to_numpy()].any()
    assert np.isnan(b.realized).any()


def test_judge_runs_the_bar_and_the_fit_reads_only_tuning_seasons(
    season: tuple[Path, Path],
) -> None:
    folder, csv = season
    p = _p()
    s = load(folder)
    res, cache = judge(s, boards(s, folder, csv, 10), p)
    for k in ("buy", "sell"):
        r = res["pooled"][k]
        assert r["judged"] > 0
        for key in ("reversal", "vs_naive", "advantage"):
            assert len(r[key]) == 3
    assert isinstance(verdict(res), list)
    with pytest.raises(SystemExit, match="not a tuning season"):
        fit([cache], p)
    got = fit([{**cache, "season": "2021-22"}], p)
    assert got["informative"] == (got["beta"] < 1)
    if got["informative"]:
        assert got["min_swing"] == pytest.approx(round(got["rmse"] / (1 - got["beta"]), 1))
    assert buy_sell_backtest.LISTS == ("buy", "sell")


def test_a_resample_without_the_flagged_players_is_left_out() -> None:
    f = buy_sell_backtest.Flagged(np.array([0, 0, 1]), np.array([1.0, 3.0, 5.0]), np.zeros(3))
    w = np.array([[1.0, 1.0, 1.0], [0.0, 0.0, 3.0], [2.0, 0.0, 1.0]])
    got = buy_sell_backtest._weighted(f, "reversal", w)
    assert got[0] == pytest.approx(3.0)
    assert np.isnan(got[1])
    assert got[2] == pytest.approx(2.0)
