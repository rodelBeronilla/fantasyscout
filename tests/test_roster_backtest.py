"""My Team's roster review backtest (#757) applies the web's rule (ops/roster.py) over arrays,
scores what happened, and keeps to its seasons: the fit reads only the tuning seasons' caches."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from ops import roster, roster_backtest, standings, standings_backtest
from ops.roster_backtest import fit, judge, naive_swap, prepare, realized, swaps, verdict
from ops.standings import CATS
from ops.standings_backtest import beat, cat_values, load
from tests.test_standings_backtest import _season


def _p(**over: Any) -> dict[str, Any]:
    p = standings.registry()
    p["backtest.standings_leagues"] = 4
    p["backtest.bootstrap"] = 30
    p.update(over)
    return p


@pytest.fixture(scope="module")
def season(tmp_path_factory: pytest.TempPathFactory) -> Path:
    folder = _season(
        tmp_path_factory.mktemp("roster") / "s", "nba", "2023-24", players=220, weeks=8
    )
    rng = np.random.default_rng(4)
    for f in folder.glob("players-*.csv"):
        df = pd.read_csv(f, dtype={"player_id": str})
        df["rank_total"] = df["value_rest_of_season"].rank(ascending=False, method="first")
        # a prior on a few players, as the NBA board carries in its first 20 games
        df["market_prior_weight"] = np.where(rng.uniform(size=len(df)) < 0.3, 0.4, 0.0)
        df["market_prior_value"] = df[list(CATS)].sum(axis=1) + rng.normal(0, 1, len(df))
        df.to_csv(f, index=False)
    return folder


def test_the_array_swap_is_the_reviews_first(season: Path) -> None:
    """Each team's swap, its gain and its chips match reviewRoster's (ops/roster.py)."""
    p = _p()
    cut = load(season).cuts[1]
    ctx = prepare(cut, p, "nba", 3)
    sw = swaps(ctx, float(p["roster.starter_share"]))
    ids = [f"p{i}" for i in range(len(ctx.rest))]
    rest = {ids[i]: float(v) for i, v in enumerate(ctx.rest)}
    rows = [
        {"player_id": ids[i], "rank_total": cut.columns["rank_total"][i], "market_rank": cut.adp[i]}
        for i in range(len(ids))
    ]
    for lg in range(ctx.rost.shape[0]):
        owned = {int(i) for i in ctx.rost[lg].ravel()}
        available = [ids[i] for i in range(len(ids)) if i not in owned]
        for t in range(ctx.teams):
            mine = [ids[int(i)] for i in ctx.rost[lg, t]]
            rule = roster.drop_rule(rows, mine, ctx.teams, ctx.spots, rest, False, p)
            review = roster.review_roster(
                mine, available, rest, [], lambda i: None, [], 0, p, droppable=rule
            )
            ups = review["upgrades"]
            gain = float(sw["gain"][lg, t])
            if ups:
                assert ups[0]["add"] == ids[int(sw["add"][lg, t])]
                assert ups[0]["drop"] == ids[int(sw["drop"][lg, t])]
                assert ups[0]["gain"] == pytest.approx(gain)
            else:
                assert gain < float(p["roster.min_gain"])
            chips = [
                ids[int(i)]
                for k, i in enumerate(ctx.rost[lg, t])
                if sw["keep"][lg, t, k] and sw["chip_gain"][lg, t, k] >= p["roster.min_gain"]
            ]
            assert sorted(chips) == sorted(review["chips"])


def test_the_rest_value_carries_the_market_prior(season: Path) -> None:
    cut = load(season).cuts[0]
    rest = roster_backtest.web_rest(cut)
    own = cut.z.sum(1)
    w = cut.columns["market_prior_weight"]
    v = own + np.where(w > 0, w * (cut.columns["market_prior_value"] - own), 0)
    assert np.allclose(rest, np.where(v > 0, v * cut.games_share * cut.ros_factor, v))
    assert not np.allclose(rest, np.where(own > 0, own * cut.games_share * cut.ros_factor, own))


def test_what_happened_is_scored_on_the_box_scores(season: Path) -> None:
    p = _p()
    ctx = prepare(load(season).cuts[0], p, "nba", 3)
    sw = naive_swap(ctx)
    r = realized(ctx, sw["add"], sw["drop"], "h2h", np.ones((1, ctx.xt.shape[0])))
    lg, t = 1, 2
    xt = ctx.xt[:, lg]
    mine = xt[:, t] + ctx.x[:, sw["add"][lg, t]] - ctx.x[:, sw["drop"][lg, t]]
    cv, cn = cat_values(xt), cat_values(mine)
    won = np.mean(
        [
            np.mean(
                [
                    beat(cn[w], cv[w, u]).sum() - beat(cv[w, t], cv[w, u]).sum()
                    for u in range(12)
                    if u != t
                ]
            )
            for w in range(len(cv))
        ]
    )
    assert r[0, lg, t] == pytest.approx(won)
    tot_new, tot = cat_values(mine.sum(0)), cat_values(xt.sum(0))
    pts = sum(beat(tot_new, tot[u]).sum() - beat(tot[t], tot[u]).sum() for u in range(12) if u != t)
    ro = realized(ctx, sw["add"], sw["drop"], "roto", np.ones((1, ctx.xt.shape[0])))
    assert ro[0, lg, t] == pytest.approx(pts)


def test_judge_runs_the_bar_and_the_fit_reads_only_tuning_seasons(season: Path) -> None:
    p = _p()
    res, cache = judge(load(season), p)
    pooled = res["pooled"]["h2h"]
    for key in ("review_vs_stand_pat", "review_vs_naive", "review_vs_no_rule", "chips_mean"):
        assert len(pooled[key]) == 3
    assert isinstance(verdict(res), list)
    with pytest.raises(SystemExit, match="not a tuning season"):
        fit([cache], p)
    got = fit([{**cache, "season": "2021-22"}], p)
    assert got["starter_share"] in roster_backtest.SHARE_GRID
    assert got["min_gain"] in roster_backtest.GAIN_GRID
    # no protection at all is the review without the drop rule
    zero = cache["cuts"][0]["grid"]["0.0"]
    ctx = prepare(
        load(season).cuts[0], p, "nba", standings_backtest._seed(load(season).cuts[0].as_of)
    )
    free = swaps(ctx, None)
    assert np.allclose(np.array(zero["gain"]), np.maximum(free["gain"], -1e9).ravel())
