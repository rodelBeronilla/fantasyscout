"""The Trade page's backtest (#756) applies the web's rules (ops/trade.py) over arrays, scores
what happened, and keeps to its seasons: the fit reads only the tuning seasons' caches."""

from __future__ import annotations

import functools
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from ops import standings, trade, trade_backtest
from ops.standings import CATS
from ops.standings_backtest import beat, cat_values, load
from ops.trade_backtest import (
    calls,
    figures,
    finder_trades,
    fit,
    h2h_realized,
    judge,
    lenses,
    predict,
    prepare,
    roto_realized,
    suggest_trades,
    verdict,
)
from tests.test_standings_backtest import _season


def _p(**over: Any) -> dict[str, Any]:
    p = standings.registry()
    p["backtest.standings_leagues"] = 3
    p["backtest.trade_leagues"] = 2
    p["backtest.trade_sample"] = 40
    p["backtest.bootstrap"] = 30
    p.update(over)
    return p


@pytest.fixture(scope="module")
def season(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _season(tmp_path_factory.mktemp("trade") / "s", "nba", "2023-24", players=200, weeks=8)


def _state(ctx: trade_backtest.Ctx, lg: int, ids: list[str]) -> trade.LeagueState:
    """The league as the web's state reads it, players named by their index."""
    rost = ctx.rost[lg]
    owned = {int(i) for i in rost.ravel()}
    players = len(ctx.rest) - 1
    free = sorted((i for i in range(players) if i not in owned), key=lambda i: -ctx.rest[i])
    za = ctx.za
    return trade.LeagueState(
        league=ctx.league,
        format="h2h",
        cats=list(CATS),
        rosters=[[ids[int(i)] for i in r] for r in rost],
        roster_spots=rost.shape[1],
        free_agents=[ids[i] for i in free],
        rest=lambda i: float(ctx.rest[int(i[1:])]),
        cat_value=lambda i: dict(zip(CATS, za[int(i[1:])].tolist(), strict=True)),
        availability=lambda i: 1.0,
        games_left=0,
    )


def _accept(
    model: trade.FairnessModel, p: dict[str, Any], t: int, g: list[str], r: list[str]
) -> bool:
    return trade.acceptable(model, t, g, r, p)


def test_the_array_rules_are_the_webs(season: Path) -> None:
    """Every finder trade's settlement, gains, lenses and verdict match ops/trade.py, and the
    finder's top trade is the web's first."""
    p = _p()
    cut = load(season).cuts[1]
    ctx = prepare(cut, p, "nba", 7)
    ids = [f"p{i}" for i in range(len(ctx.rest))]
    for fmt in ("h2h", "roto"):
        state = _state(ctx, 0, ids)
        state = trade.LeagueState(**{**state.__dict__, "format": fmt, "games_left": cut.games_left})
        st = trade.league_standings(state, 0, p)
        assert st is not None
        ft = finder_trades(ctx, 0, p)
        pr = predict(ctx, 0, ft, fmt)
        ln = lenses(ctx, ft)
        thr = trade_backtest.threshold(ctx, fmt, p)
        assert thr == pytest.approx(trade.meaningful(state, 0, p))
        cl = calls(ln, pr["gain"], thr, p)
        market = {ids[i]: float(ctx.market[i]) for i in range(len(ids) - 1)}
        model = trade.FairnessModel(
            state=state,
            mine=0,
            value=state.rest,
            market=market,
            ranked=lambda i: bool(ctx.ranked[int(i[1:])]),
        )
        rng = np.random.default_rng(0)
        for k in rng.choice(len(ft.a), 60, replace=False):
            a, b = int(ft.a[k]), int(ft.b[k])
            give = [ids[i] for i in ft.give[k] if i < len(ids) - 1]
            get = [ids[i] for i in ft.get[k] if i < len(ids) - 1]
            st_a = trade.league_standings(state, a, p)
            assert st_a is not None
            impact = trade.trade_impact(state, st_a, a, b, give, get, p)
            assert pr["gain"][k] == pytest.approx(impact["mine"]["gain"], abs=1e-9)
            assert pr["partner_gain"][k] == pytest.approx(impact["partner"]["gain"], abs=1e-9)
            sides = impact["sides"]
            pad = len(ids) - 1
            out = sorted(ids[i] for i in ft.mo[k] if i < pad)
            assert out == sorted(give + sides["mine"]["dropped"])
            inc = sorted(ids[i] for i in ft.mi[k] if i < pad)
            assert inc == sorted(get + sides["mine"]["added"])
            model_a = trade.FairnessModel(model.state, a, model.value, model.market, model.ranked)
            lz = trade.trade_lenses(model_a, b, give, get)
            assert ln["value_share"][k] == pytest.approx(lz["value"]["share"], abs=1e-12)
            if lz["market"] is None:
                assert np.isnan(ln["market_share"][k])
            else:
                assert ln["market_share"][k] == pytest.approx(lz["market"]["share"], abs=1e-12)
            j = trade.judge(lz["value"], lz["market"], impact["mine"]["gain"], thr, p)
            assert bool(cl["even"][k]) == j["even"]
            severity = "terrible" if cl["terrible"][k] else "bad" if cl["bad"][k] else "fine"
            assert severity == j["severity"]
            assert bool(cl["acceptable"][k]) == trade.acceptable(model_a, b, give, get, p)
        # the finder's first trade for team 0
        rest = {i: max(0.0, state.rest(i)) for i in ids[:-1]}
        others = standings.rivals(state.rosters, 0, state.roster_spots, p)

        def effect(
            partner: int,
            g: list[str],
            r: list[str],
            state: trade.LeagueState = state,
            st: dict[str, Any] = st,
        ) -> dict[str, Any]:
            e = trade.trade_impact(state, st, 0, partner, g, r, p)
            return {"gain": e["mine"]["gain"], "partnerGain": e["partner"]["gain"]}

        found = trade.find_trades(
            state.rosters[0],
            [(t, state.rosters[t]) for t in others],
            rest,
            effect,
            thr,
            p,
            win_win=True,
            accept=functools.partial(_accept, model, p),
        )
        win = cl["acceptable"] & (pr["partner_gain"] > 0) & (pr["gain"] >= thr)
        best = trade_backtest._best(ft.a, win, [pr["gain"], pr["partner_gain"]], 12)[0]
        if found:
            assert best >= 0
            assert [ids[i] for i in ft.give[best] if i < len(ids) - 1] == found[0]["give"]
            assert [ids[i] for i in ft.get[best] if i < len(ids) - 1] == found[0]["get"]
        else:
            assert best == -1


def test_what_happened_is_scored_on_the_box_scores(season: Path) -> None:
    p = _p()
    cut = load(season).cuts[0]
    ctx = prepare(cut, p, "nba", 3)
    ft = finder_trades(ctx, 1, p).take(np.arange(5))
    r = h2h_realized(ctx, 1, ft)
    # by hand for the first trade: the manager's weekly totals after it against each rival
    k, a, b = 0, int(ft.a[0]), int(ft.b[0])
    xt = ctx.xt[:, 1].copy()
    xa = xt[:, a] + ctx.x[:, ft.mi[k]].sum(1) - ctx.x[:, ft.mo[k]].sum(1)
    xb = xt[:, b] + ctx.x[:, ft.pi[k]].sum(1) - ctx.x[:, ft.po[k]].sum(1)
    after = xt.copy()
    after[:, a], after[:, b] = xa, xb
    teams = xt.shape[1]

    def won(table: np.ndarray) -> np.ndarray:
        cv = cat_values(table)
        return np.array(
            [
                sum(beat(cv[w, a], cv[w, u]).sum() for u in range(teams) if u != a) / (teams - 1)
                for w in range(len(cv))
            ]
        )

    assert np.allclose(r["mine"][0], won(after) - won(xt))
    # the season as it was, as one weighting of the weeks, gives rotisserie points
    ro = roto_realized(ctx, 1, ft, np.ones((1, xt.shape[0])))
    tot_after, tot_before = cat_values(after.sum(0)), cat_values(xt.sum(0))
    pts = sum(beat(tot_after[a], tot_after[u]).sum() for u in range(teams) if u != a) - sum(
        beat(tot_before[a], tot_before[u]).sum() for u in range(teams) if u != a
    )
    assert ro["mine"][0, 0] == pytest.approx(pts)


def test_suggestions_ask_for_the_partners_best_player(season: Path) -> None:
    p = _p()
    ctx = prepare(load(season).cuts[0], p, "nba", 3)
    st = suggest_trades(ctx, 0, p, np.random.default_rng(0))
    pad = len(ctx.rest) - 1
    for a in range(12):
        mine = st.b[st.a == a]
        assert len(set(mine.tolist())) == 1
        gets = st.get[st.a == a]
        assert (gets[:, 0] == gets[0, 0]).all() and (gets[:, 1:] == pad).all()
    # three for one: the manager adds two free agents, the partner drops two
    three = (st.give < pad).sum(1) == 3
    assert ((st.mi < pad).sum(1)[three] == 3).all()
    assert ((st.po < pad).sum(1)[three] == 3).all()


def test_judge_runs_the_bar_and_the_fit_reads_only_tuning_seasons(
    season: Path, tmp_path: Path
) -> None:
    p = _p()
    res, cache = judge(load(season), p)
    pooled = res["pooled"]["h2h"]
    for key in ("finder_vs_stand_pat", "finder_vs_naive", "suggest_vs_naive", "slope", "even_mean"):
        assert len(pooled[key]) == 3
    assert pooled["sample"] == 2 * 2 * 40
    assert isinstance(verdict(res, p), list)
    assert len(cache["cuts"]) == 2
    with pytest.raises(SystemExit, match="not a tuning season"):
        fit([cache], p)
    tuning = {**cache, "season": "2021-22"}
    got = fit([tuning], p)
    assert got["meaningful_gain"] in trade_backtest.MEANINGFUL_GRID
    if got["value"] and got["value"]["informative"]:
        assert got["value"]["bad"] == pytest.approx(-got["value"]["even"], abs=0.011)
        assert got["value"]["terrible"] <= got["value"]["bad"]


def test_the_figures_pick_one_trade_a_team(season: Path) -> None:
    p = _p()
    ctx = prepare(load(season).cuts[1], p, "nba", 5)
    figs = figures(ctx, p, 5)
    for fmt in ("h2h", "roto"):
        for name, groups in figs[fmt].picks.items():
            for _, t in groups:
                assert len(set(t.a.tolist())) == len(t.a), name
        assert sum(len(t.a) for _, t in figs[fmt].sample) == 2 * 40
