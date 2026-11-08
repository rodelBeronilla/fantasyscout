"""Walk-forward backtest of the Trade page (#756): the verdict's lenses, the even band, the
suggestions and the finder, judged on simulated leagues of real seasons.

    uv run python -m ops.walk_forward --league nba --season 2023-24 --standings-out standings/
    uv run python -m ops.trade_backtest judge standings/ --out trades.json --cache trades.npz
    uv run python -m ops.trade_backtest fit tuning-2020-21.npz tuning-2021-22.npz ...

The leagues are #755's (ops.standings_backtest.simulate): at each checkpoint, snake drafts of the
default size, every player active for the rest of the season. The first
``backtest.trade_leagues`` of them are traded in. The rules are the web's, mirrored in ops/trade.py
and pinned to it by tests/test_trade_backtest.py:

- **candidates:** the finder's shapes (one for one, two for one, one for two) between every pair
  of teams, over each side's ``trade.search.candidates`` most valuable players, the roster spots
  settled as rostersAfter settles them;
- **predicted:** each side's change in expected categories won a week (head-to-head) or
  rotisserie points, from the standings model; the value, market and category lenses; the
  verdict (severity, even) and whether the trade is acceptable;
- **what happened:** each side's realized change over the rest of the season, from the real box
  scores: categories won a week against every other team (all-play), or rotisserie points, the
  other rosters as they were.

Judged, per format and pooled over the checkpoints:

- **the finder, by decision replay:** each team makes the finder's top trade (or stands pat),
  against standing pat, the naive manager (the best trade by season-so-far value that the partner
  would not call bad by it), the value lens alone and the market;
- **the suggestions, by decision replay:** each team asks a partner drawn at random for their
  best player and makes the top suggestion, against standing pat and the naive manager's package;
- **calibration**, on a sample of the candidates: the slope of the realized change on the
  predicted gain; what the trades called even, bad or terrible went on to do; the categories a
  trade lists as up or down; the categories called conceded or locked.

Intervals are 95%, from ``backtest.bootstrap`` resamples of the season's weeks, as in #755. The
pass bar was declared on #756 before any run; ``verdict`` applies it. ``fit`` reads the tuning
seasons' caches only.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ops import standings, trade
from ops.standings import CATS
from ops.standings_backtest import (
    JUDGED,
    TUNING,
    Cut,
    Season,
    _interval,
    _seed,
    beat,
    cat_values,
    load,
    simulate,
)
from ops.walk_forward import LOCKED

FORMATS = ("h2h", "roto")
FINDER_ARMS = ("finder", "naive", "value", "market")
SUGGEST_ARMS = ("suggest", "naive", "value")
SLOPE = (0.8, 1.25)
MEANINGFUL_GRID = tuple(round(0.01 * i, 2) for i in range(51))
WIDTH = 3  # the most players a side of a settled trade sends or receives here
# the rotisserie figures re-sum the season for this many resamples at a time
CHUNK = 50

__all__ = ["JUDGED", "TUNING", "fit", "judge", "verdict"]


# ---- one checkpoint's leagues ----------------------------------------------------------------


@dataclass
class Ctx:
    """A checkpoint's traded leagues and each player's figures, with a padding player (index P)
    who has nothing, for a side with fewer than WIDTH players."""

    league: str
    rost: np.ndarray  # [L, T, R]
    xt: np.ndarray  # [W, L, T, 11]
    tot: np.ndarray  # [L, T, 9]
    spread: dict[str, np.ndarray]  # fmt: [L, 9]
    rest: np.ndarray  # [P + 1] the web's rest-of-season value
    market: np.ndarray  # [P + 1] the market lens's price
    ranked: np.ndarray  # [P + 1] bool
    naive: np.ndarray  # [P + 1] season-so-far value per game
    za: np.ndarray  # [P + 1, 9] category values times availability
    x: np.ndarray  # [W, P + 1, 11]
    free: np.ndarray  # [L, 3] the best free agents, best first
    rivals: int
    has_market: bool


def web_rest(cut: Cut) -> np.ndarray:
    """The web's rest-of-season value (league-model.ts playerWorth, the default league): the
    nine categories' sum, its positive part scaled by games share and ros_factor."""
    v = cut.z.sum(1)
    out: np.ndarray = np.where(v > 0, v * cut.games_share * cut.ros_factor, v)
    return out


def market_prices(rest: np.ndarray, adp: np.ndarray) -> np.ndarray:
    """trade-fairness.ts marketValues: a rank priced at the value the board's player of that rank
    has, an unranked player at their own."""
    curve = np.sort(np.maximum(rest, 0))[::-1]
    ok = np.isfinite(adp) & (adp >= 1) & (adp <= len(curve))
    whole = ok & (np.mod(np.where(ok, adp, 1), 1) == 0)
    idx = np.where(whole, np.where(ok, adp, 1) - 1, 0).astype(int)
    out: np.ndarray = np.where(whole, curve[idx], np.where(ok, 0.0, rest))
    return out


def prepare(cut: Cut, p: dict[str, Any], league: str, seed: int) -> Ctx:
    lg = simulate(cut, p, league, seed)
    n = int(p["backtest.trade_leagues"])
    rost = lg.rost[:n]
    players = len(cut.z)
    rest = web_rest(cut)
    pad = np.zeros(1)
    owned = np.zeros((len(rost), players), dtype=bool)
    np.put_along_axis(owned, rost.reshape(len(rost), -1), True, axis=1)
    order = np.argsort(-rest, kind="stable")
    free = np.stack([order[~owned[i][order]][:3] for i in range(len(rost))])
    teams = rost.shape[1]
    spread = {
        "h2h": standings.spreads(league, CATS, lg.n[:n], "h2h", p=p),
        "roto": standings.spreads(league, CATS, lg.n[:n], "roto", cut.games_left, p=p),
    }
    return Ctx(
        league=league,
        rost=rost,
        xt=lg.xt[:, :n],
        tot=lg.tot[:n],
        spread=spread,
        rest=np.concatenate([rest, pad]),
        market=np.concatenate([market_prices(rest, cut.adp), pad]),
        ranked=np.concatenate([np.isfinite(cut.adp), [False]]),
        naive=np.concatenate([cut.naive.sum(1), pad]),
        za=np.concatenate([cut.z * cut.avail[:, None], np.zeros((1, len(CATS)))]),
        x=np.concatenate([cut.x, np.zeros((cut.x.shape[0], 1, cut.x.shape[2]))], axis=1),
        free=free,
        rivals=teams - 1,
        has_market=bool(np.isfinite(cut.adp).any()),
    )


# ---- candidate trades ------------------------------------------------------------------------


@dataclass
class Trades:
    """Trades within one league: the manager's team, the partner and what each side sends (out)
    and receives (in) once the roster spots are settled, padded with the padding player."""

    a: np.ndarray  # [K]
    b: np.ndarray
    give: np.ndarray  # [K, WIDTH] the trade itself
    get: np.ndarray
    mo: np.ndarray  # [K, WIDTH] the manager's side out (give and drops) and in (get and adds)
    mi: np.ndarray
    po: np.ndarray
    pi: np.ndarray
    extra: dict[str, np.ndarray] = field(default_factory=dict)

    def take(self, idx: np.ndarray) -> Trades:
        return Trades(
            a=self.a[idx],
            b=self.b[idx],
            give=self.give[idx],
            get=self.get[idx],
            mo=self.mo[idx],
            mi=self.mi[idx],
            po=self.po[idx],
            pi=self.pi[idx],
            extra={k: v[idx] for k, v in self.extra.items()},
        )


def _trades(rows: dict[str, list[Any]], pad: int) -> Trades:
    return Trades(
        a=np.array(rows["a"], dtype=int),
        b=np.array(rows["b"], dtype=int),
        give=_pad(rows["give"], pad),
        get=_pad(rows["get"], pad),
        mo=_pad(rows["mo"], pad),
        mi=_pad(rows["mi"], pad),
        po=_pad(rows["po"], pad),
        pi=_pad(rows["pi"], pad),
    )


def _pad(rows: list[list[int]], pad: int) -> np.ndarray:
    out = np.full((len(rows), WIDTH), pad, dtype=int)
    for i, r in enumerate(rows):
        out[i, : len(r)] = r
    return out


def top(ctx: Ctx, roster: np.ndarray, n: int) -> list[int]:
    """trade-suggest.ts top(): the roster's ``n`` most valuable players worth more than
    replacement, best first (the roster's order breaking ties)."""
    r = [int(i) for i in roster if ctx.rest[i] > 0]
    return sorted(r, key=lambda i: -ctx.rest[i])[:n]


def settle(
    ctx: Ctx, lg: int, a: int, b: int, give: list[int], get: list[int]
) -> tuple[list[int], list[int], list[int], list[int]]:
    """trade-impact.ts rostersAfter: the side that receives more drops its lowest-valued players
    (the first of equals in the roster's order), the one that sends more adds the best free
    agents, the manager's side first. Returns the manager's out and in, the partner's out and in."""
    fa = [int(i) for i in ctx.free[lg]]

    def side(team: int, out: list[int], incoming: list[int]) -> tuple[list[int], list[int]]:
        before = [int(i) for i in ctx.rost[lg, team]]
        after = [i for i in before if i not in out] + incoming
        dropped = []
        while len(after) > len(before):
            worst = after[0]
            for i in after[1:]:
                if ctx.rest[i] < ctx.rest[worst]:
                    worst = i
            after.remove(worst)
            dropped.append(worst)
        added: list[int] = []
        while len(after) + len(added) < len(before) and fa:
            added.append(fa.pop(0))
        return out + dropped, incoming + added

    mo, mi = side(a, give, get)
    po, pi = side(b, get, give)
    return mo, mi, po, pi


def finder_trades(ctx: Ctx, lg: int, p: dict[str, Any]) -> Trades:
    """Every trade the finder tries in league ``l``: each team with each other team."""
    n = int(p["trade.search"]["candidates"])
    teams = ctx.rost.shape[1]
    tops = [top(ctx, ctx.rost[lg, t], n) for t in range(teams)]
    rows: dict[str, list[Any]] = {k: [] for k in ("a", "b", "give", "get", "mo", "mi", "po", "pi")}
    for a in range(teams):
        mine = tops[a]
        for b in range(teams):
            if b == a:
                continue
            theirs = tops[b]
            singles_m = [[i] for i in mine]
            singles_t = [[i] for i in theirs]
            pairs_m = [list(c) for c in trade.combinations(mine, 2) if len(c) == 2]
            pairs_t = [list(c) for c in trade.combinations(theirs, 2) if len(c) == 2]
            for gives, gets in ((singles_m, singles_t), (pairs_m, singles_t), (singles_m, pairs_t)):
                for g in gives:
                    for r in gets:
                        mo, mi, po, pi = settle(ctx, lg, a, b, g, r)
                        for k, v in zip(rows, (a, b, g, r, mo, mi, po, pi), strict=True):
                            rows[k].append(v)
    return _trades(rows, len(ctx.rest) - 1)


def suggest_trades(ctx: Ctx, lg: int, p: dict[str, Any], rng: np.random.Generator) -> Trades:
    """Each team asks a partner drawn at random for that partner's most valuable player; the
    suggestions fill the give side from the manager's ``trade.search.pool`` most valuable."""
    search = p["trade.search"]
    teams = ctx.rost.shape[1]
    rows: dict[str, list[Any]] = {k: [] for k in ("a", "b", "give", "get", "mo", "mi", "po", "pi")}
    for a in range(teams):
        b = int((a + 1 + rng.integers(0, teams - 1)) % teams)
        target = top(ctx, ctx.rost[lg, b], 1)
        pool = top(ctx, ctx.rost[lg, a], int(search["pool"]))
        if not target:
            continue
        for combo in trade.combinations(pool, int(search["max_add"])):
            g = list(combo)
            mo, mi, po, pi = settle(ctx, lg, a, b, g, target)
            for k, v in zip(rows, (a, b, g, target, mo, mi, po, pi), strict=True):
                rows[k].append(v)
    return _trades(rows, len(ctx.rest) - 1)


# ---- what the tool says ----------------------------------------------------------------------


def _lens(v: np.ndarray, out: np.ndarray, inc: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """trade-fairness.ts lens over padded sides: net and share, a player below replacement zero."""
    g = np.maximum(v[out], 0).sum(1)
    r = np.maximum(v[inc], 0).sum(1)
    net = r - g
    out_share: np.ndarray = net / np.maximum(np.maximum(g, r), 1e-9)
    return net, out_share


def predict(ctx: Ctx, lg: int, t: Trades, fmt: str) -> dict[str, np.ndarray]:
    """trade-impact.ts tradeImpact for every trade: both sides' gain and the manager's change in
    each category's chance."""
    tot = ctx.tot[lg]
    s = ctx.spread[fmt][lg]
    teams = tot.shape[0]
    da = ctx.za[t.mi].sum(1) - ctx.za[t.mo].sum(1)
    db = ctx.za[t.pi].sum(1) - ctx.za[t.po].sum(1)
    k = len(t.a)
    new = np.broadcast_to(tot, (k, teams, len(CATS))).copy()
    rows = np.arange(k)
    new[rows, t.a] += da
    new[rows, t.b] += db
    off = ~np.eye(teams, dtype=bool)

    def chances(totals: np.ndarray, team: np.ndarray) -> np.ndarray:
        mine = totals[rows, team][:, None, :]
        c = standings.normal_cdf((mine - totals) / s)
        mask = off[team][:, :, None]
        out: np.ndarray = (c * mask).sum(1) / (teams - 1)
        return out

    before = chance_bands(ctx, lg, fmt)
    before_a, after_a = before[t.a], chances(new, t.a)
    before_b, after_b = before[t.b], chances(new, t.b)

    def score(ch: np.ndarray) -> np.ndarray:
        w = ch.sum(-1)
        out: np.ndarray = len(CATS) + w * (teams - 1) if fmt == "roto" else w
        return out

    return {
        "gain": score(after_a) - score(before_a),
        "partner_gain": score(after_b) - score(before_b),
        "dchance": after_a - before_a,
    }


def lenses(ctx: Ctx, t: Trades) -> dict[str, np.ndarray]:
    vnet, vshare = _lens(ctx.rest, t.mo, t.mi)
    mnet, mshare = _lens(ctx.market, t.mo, t.mi)
    nnet, nshare = _lens(ctx.naive, t.mo, t.mi)
    has = ctx.ranked[np.concatenate([t.give, t.get], axis=1)].any(1)
    return {
        "value_net": vnet,
        "value_share": vshare,
        "market_net": mnet,
        "market_share": np.where(has, mshare, np.nan),
        "naive_net": nnet,
        "naive_share": nshare,
    }


def threshold(ctx: Ctx, fmt: str, p: dict[str, Any]) -> float:
    m = trade.meaningful_gain(ctx.league, p)
    return m * max(1, ctx.rivals) if fmt == "roto" else m


def calls(
    ln: dict[str, np.ndarray], gain: np.ndarray, thr: float, p: dict[str, Any]
) -> dict[str, np.ndarray]:
    """trade-fairness.ts judge and league-model.ts acceptable, over arrays."""
    vl, ml, cl, ev = (
        p["trade.value_limits"],
        p["trade.market_limits"],
        p["trade.category_limits"],
        p["trade.even"],
    )
    v, m = ln["value_share"], ln["market_share"]
    has = np.isfinite(m)
    mm = np.where(has, m, 0.0)
    terrible = (v <= vl["terrible"]) | (has & (mm <= ml["terrible"]))
    bad = (v <= vl["bad"]) | (has & (mm <= ml["bad"]))
    if thr > 0:
        terrible |= gain <= -cl["terrible"] * thr
        bad |= gain <= -cl["bad"] * thr
    even = (np.abs(v) <= ev["value"]) & (~has | (np.abs(mm) <= ev["market"]))
    even &= np.abs(gain) < cl["bad"] * thr
    acceptable = (v > vl["bad"]) & (~has | (mm > ml["bad"]))
    disagree = has & (np.abs(v - mm) >= p["trade.disagreement"]) & (np.sign(v) != np.sign(mm))
    return {
        "terrible": terrible,
        "bad": bad & ~terrible,
        "even": even,
        "acceptable": acceptable,
        "disagree": disagree,
    }


def _best(team: np.ndarray, ok: np.ndarray, keys: list[np.ndarray], teams: int) -> np.ndarray:
    """Per team, the index of the qualifying trade that sorts first by ``keys`` (each larger
    first, then the earliest), or -1."""
    out = np.full(teams, -1, dtype=int)
    idx = np.nonzero(ok)[0]
    if not len(idx):
        return out
    order = np.lexsort([idx] + [-k[idx] for k in reversed(keys)] + [team[idx]])
    picked = idx[order]
    first = np.r_[True, team[picked][1:] != team[picked][:-1]]
    out[team[picked][first]] = picked[first]
    return out


# ---- what happened ---------------------------------------------------------------------------


def _new_weeks(ctx: Ctx, lg: int, t: Trades) -> tuple[np.ndarray, np.ndarray]:
    """Both sides' weekly totals after the trade: [K, W, 11] each."""
    xt = ctx.xt[:, lg]  # [W, T, 11]
    xa = xt[:, t.a].transpose(1, 0, 2) + (ctx.x[:, t.mi].sum(2) - ctx.x[:, t.mo].sum(2)).transpose(
        1, 0, 2
    )
    xb = xt[:, t.b].transpose(1, 0, 2) + (ctx.x[:, t.pi].sum(2) - ctx.x[:, t.po].sum(2)).transpose(
        1, 0, 2
    )
    return xa, xb


def h2h_realized(ctx: Ctx, lg: int, t: Trades) -> dict[str, np.ndarray]:
    """Each side's realized change, week by week: categories won against every other team, and
    the manager's share of them won per category. [K, W] and [K, W, 9]."""
    xa, xb = _new_weeks(ctx, lg, t)
    cv = cat_values(ctx.xt[:, lg])  # [W, T, 9]
    teams = cv.shape[1]
    k = len(t.a)
    rows = np.arange(k)
    base = np.broadcast_to(cv, (k, *cv.shape)).copy()  # [K, W, T, 9]
    new = base.copy()
    new[rows, :, t.a] = cat_values(xa)
    new[rows, :, t.b] = cat_values(xb)
    off = ~np.eye(teams, dtype=bool)

    def share(table: np.ndarray, team: np.ndarray) -> np.ndarray:
        mine = table[rows, :, team][:, :, None, :]
        w = beat(mine, table) * off[team][:, None, :, None]
        out: np.ndarray = w.sum(2) / (teams - 1)
        return out

    sa_new, sa_old = share(new, t.a), share(base, t.a)
    sb_new, sb_old = share(new, t.b), share(base, t.b)
    return {
        "mine": (sa_new - sa_old).sum(-1),
        "partner": (sb_new - sb_old).sum(-1),
        "cats": sa_new - sa_old,
    }


def roto_realized(ctx: Ctx, lg: int, t: Trades, weights: np.ndarray) -> dict[str, np.ndarray]:
    """Each side's realized change in rotisserie points for each weighting of the weeks
    ([B, W]): [B, K], and the manager's per category [B, K, 9]."""
    xa, xb = _new_weeks(ctx, lg, t)
    out: dict[str, list[np.ndarray]] = {"mine": [], "partner": [], "cats": []}
    teams = ctx.xt.shape[2]
    off = ~np.eye(teams, dtype=bool)
    k = len(t.a)
    rows = np.arange(k)
    for s in range(0, len(weights), CHUNK):
        c = weights[s : s + CHUNK]
        tot = np.einsum("bw,wtf->btf", c, ctx.xt[:, lg])  # [B, T, 11]
        base = np.broadcast_to(cat_values(tot)[:, None], (len(c), k, teams, len(CATS))).copy()
        new = base.copy()
        new[:, rows, t.a] = cat_values(np.einsum("bw,kwf->bkf", c, xa))
        new[:, rows, t.b] = cat_values(np.einsum("bw,kwf->bkf", c, xb))

        def pts(table: np.ndarray, team: np.ndarray) -> np.ndarray:
            mine = table[:, rows, team][:, :, None, :]
            r: np.ndarray = (beat(mine, table) * off[team][None, :, :, None]).sum(2)
            return r

        pa = pts(new, t.a) - pts(base, t.a)
        out["mine"].append(pa.sum(-1))
        out["partner"].append((pts(new, t.b) - pts(base, t.b)).sum(-1))
        out["cats"].append(pa / (teams - 1))
    return {key: np.concatenate(v) for key, v in out.items()}


def chance_bands(ctx: Ctx, lg: int, fmt: str) -> np.ndarray:
    """Every team's chance per category against an average rival before any trade: [T, 9]."""
    tot, s = ctx.tot[lg], ctx.spread[fmt][lg]
    teams = tot.shape[0]
    off = ~np.eye(teams, dtype=bool)
    c = standings.normal_cdf((tot[:, None, :] - tot[None, :, :]) / s)
    out: np.ndarray = (c * off[..., None]).sum(1) / (teams - 1)
    return out


# ---- one checkpoint --------------------------------------------------------------------------


@dataclass
class FormatFigures:
    """One format's trades at a checkpoint: each replay arm's picks and the calibration sample,
    per league, and every team's category chances before any trade."""

    picks: dict[str, list[tuple[int, Trades]]]
    sample: list[tuple[int, Trades]]
    chances: np.ndarray  # [L, T, 9]
    threshold: float


def _picked(t: Trades, idx: np.ndarray, pr: dict[str, np.ndarray]) -> Trades:
    """The picked trade of each team that made one."""
    made = idx[idx >= 0]
    out = t.take(made)
    out.extra = {"gain": pr["gain"][made], "partner_gain": pr["partner_gain"][made]}
    return out


def _empty_picks() -> dict[str, list[tuple[int, Trades]]]:
    names = [f"finder.{a}" for a in FINDER_ARMS] + [f"suggest.{a}" for a in SUGGEST_ARMS]
    return {n: [] for n in [*names, "top"]}


def figures(ctx: Ctx, p: dict[str, Any], seed: int) -> dict[str, FormatFigures]:
    """Every league's candidates, what the tool says of them and what each arm picks."""
    rng = np.random.default_rng(seed + 1)
    srng = np.random.default_rng(seed + 2)
    leagues, teams = ctx.rost.shape[:2]
    per_league = int(p["backtest.trade_sample"])
    vl, ml = p["trade.value_limits"]["bad"], p["trade.market_limits"]["bad"]
    tol = p["trade.suggest"]["tolerance"]
    pad = len(ctx.rest) - 1
    out = {
        fmt: FormatFigures(
            picks=_empty_picks(),
            sample=[],
            chances=np.stack([chance_bands(ctx, lg, fmt) for lg in range(leagues)]),
            threshold=threshold(ctx, fmt, p),
        )
        for fmt in FORMATS
    }
    for lg in range(leagues):
        ft = finder_trades(ctx, lg, p)
        ln = lenses(ctx, ft)
        sample = np.sort(rng.choice(len(ft.a), size=min(per_league, len(ft.a)), replace=False))
        # the arms that do not read the standings model pick the same trade in either format
        plain = {
            "naive": _best(
                ft.a, (ln["naive_net"] > 0) & (ln["naive_share"] < -vl), [ln["naive_net"]], teams
            ),
            "value": _best(
                ft.a, (ln["value_net"] > 0) & (ln["value_share"] < -vl), [ln["value_net"]], teams
            ),
        }
        if ctx.has_market:
            ms = np.nan_to_num(ln["market_share"], nan=np.inf)
            plain["market"] = _best(
                ft.a, (ln["market_net"] > 0) & (ms < -ml), [ln["market_net"]], teams
            )
        st = suggest_trades(ctx, lg, p, srng)
        sl = lenses(ctx, st)
        size = (st.give < pad).sum(1) + 1
        g_naive = np.maximum(ctx.naive[st.give], 0).sum(1)
        r_naive = np.maximum(ctx.naive[st.get], 0).sum(1)
        g_value = np.maximum(ctx.rest[st.give], 0).sum(1)
        r_value = np.maximum(ctx.rest[st.get], 0).sum(1)
        near_naive = np.abs(r_naive - g_naive) <= tol * np.maximum(np.maximum(g_naive, r_naive), 1)
        near_value = np.abs(r_value - g_value) <= tol * np.maximum(np.maximum(g_value, r_value), 1)
        for fmt in FORMATS:
            ff = out[fmt]
            thr = ff.threshold
            pr = predict(ctx, lg, ft, fmt)
            cl = calls(ln, pr["gain"], thr, p)
            win = cl["acceptable"] & (pr["partner_gain"] > 0)
            keys = [pr["gain"], pr["partner_gain"]]
            arms = {"finder": _best(ft.a, win & (pr["gain"] >= thr), keys, teams), **plain}
            for arm, idx in arms.items():
                ff.picks[f"finder.{arm}"].append((lg, _picked(ft, idx, pr)))
            ff.picks["top"].append((lg, _picked(ft, _best(ft.a, win, keys, teams), pr)))
            s = ft.take(sample)
            s.extra = {
                "gain": pr["gain"][sample],
                "dchance": pr["dchance"][sample],
                "value_share": ln["value_share"][sample],
                "market_share": ln["market_share"][sample],
                **{k: v[sample] for k, v in cl.items()},
            }
            ff.sample.append((lg, s))
            if len(st.a):
                sp = predict(ctx, lg, st, fmt)
                sc = calls(sl, sp["gain"], thr, p)
                ok = sc["acceptable"] & (sp["gain"] >= thr) & (sp["partner_gain"] > 0)
                sarms = {
                    "suggest": _best(st.a, ok, [sp["gain"], sp["partner_gain"], -size], teams),
                    "naive": _best(st.a, near_naive, [r_naive - g_naive, -size], teams),
                    "value": _best(
                        st.a, near_value & sc["acceptable"], [r_value - g_value, -size], teams
                    ),
                }
                for arm, idx in sarms.items():
                    ff.picks[f"suggest.{arm}"].append((lg, _picked(st, idx, sp)))
    return out


# ---- judging ---------------------------------------------------------------------------------


@dataclass
class Realized:
    """One format's realized figures for per-league groups of trades, per weighting of the
    weeks: [B, K] for the manager and the partner, [B, K, 9] by category. The first weighting
    is the season as it was (all ones)."""

    mine: np.ndarray
    partner: np.ndarray
    cats: np.ndarray


def realize(ctx: Ctx, groups: list[tuple[int, Trades]], fmt: str, weights: np.ndarray) -> Realized:
    """``weights`` [B, W] are already the checkpoint's weeks."""
    mine, partner, cats = [], [], []
    tot = weights.sum(1, keepdims=True)
    safe = np.where(tot > 0, tot, 1)
    for lg, t in groups:
        if not len(t.a):
            continue
        if fmt == "h2h":
            r = h2h_realized(ctx, lg, t)
            mine.append(weights @ r["mine"].T / safe)
            partner.append(weights @ r["partner"].T / safe)
            cats.append(np.einsum("bw,kwc->bkc", weights, r["cats"]) / safe[:, :, None])
        else:
            r = roto_realized(ctx, lg, t, weights)
            mine.append(r["mine"])
            partner.append(r["partner"])
            cats.append(r["cats"])
    b = len(weights)
    if not mine:
        return Realized(np.zeros((b, 0)), np.zeros((b, 0)), np.zeros((b, 0, len(CATS))))
    return Realized(
        np.concatenate(mine, axis=1), np.concatenate(partner, axis=1), np.concatenate(cats, axis=1)
    )


def _cat(groups: list[tuple[int, Trades]], key: str) -> np.ndarray:
    parts = [t.extra[key] for _, t in groups if len(t.a)]
    return np.concatenate(parts) if parts else np.zeros(0)


def _realized_shares(ctx: Ctx, fmt: str, w: np.ndarray) -> np.ndarray:
    """Every team's realized share of rivals beaten per category, per weighting: [B, L, T, 9]."""
    teams = ctx.rost.shape[1]
    off = ~np.eye(teams, dtype=bool)
    if fmt == "h2h":
        cv = cat_values(ctx.xt)  # [W, L, T, 9]
        weekly = (
            beat(cv[:, :, :, None, :], cv[:, :, None, :, :]) * off[None, None, ..., None]
        ).sum(3) / (teams - 1)
        tot = w.sum(1)
        out: np.ndarray = (
            np.einsum("bw,wltc->bltc", w, weekly) / np.where(tot > 0, tot, 1)[:, None, None, None]
        )
        return out
    parts = []
    for s in range(0, len(w), CHUNK):
        cvt = cat_values(np.einsum("bw,wltf->bltf", w[s : s + CHUNK], ctx.xt))
        parts.append(
            (beat(cvt[:, :, :, None, :], cvt[:, :, None, :, :]) * off[None, None, ..., None]).sum(3)
            / (teams - 1)
        )
    return np.concatenate(parts)


def cut_stats(ctx: Ctx, ff: FormatFigures, fmt: str, w: np.ndarray) -> dict[str, Any]:
    """One checkpoint's figures for each weighting of the weeks (row 0: as it was)."""
    teams = int(np.prod(ctx.rost.shape[:2]))
    out: dict[str, Any] = {"replay": {}, "trades": {}, "partner": {}}
    for name, groups in ff.picks.items():
        if name == "top" or not groups:
            continue
        r = realize(ctx, groups, fmt, w)
        out["replay"][name] = r.mine.sum(1) / teams
        out["trades"][name] = int(r.mine.shape[1])
        out["partner"][name] = (r.partner.sum(1), int(r.partner.shape[1]))
    r = realize(ctx, ff.sample, fmt, w)
    out["sample"] = {
        "gain": _cat(ff.sample, "gain"),
        "realized": r.mine,
        "cats": r.cats,
        "dchance": np.concatenate([t.extra["dchance"] for _, t in ff.sample if len(t.a)]),
        **{
            k: _cat(ff.sample, k).astype(bool)
            for k in ("even", "bad", "terrible", "disagree", "acceptable")
        },
        "value_share": _cat(ff.sample, "value_share"),
    }
    out["bands"] = (ff.chances, _realized_shares(ctx, fmt, w))
    return out


def judge(
    season: Season, p: dict[str, Any], *, seed: int = 0
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The season's figures against the bar, and the cache ``fit`` reads."""
    resamples = int(p["backtest.bootstrap"])
    rng = np.random.default_rng(seed)
    draws = rng.multinomial(
        len(season.weeks), np.full(len(season.weeks), 1 / len(season.weeks)), size=resamples
    ).astype(float)
    keep = np.all([draws[:, c.weeks].sum(1) > 0 for c in season.cuts], axis=0)
    per_fmt: dict[str, list[dict[str, Any]]] = {fmt: [] for fmt in FORMATS}
    cache: dict[str, Any] = {"league": season.league, "season": season.season, "cuts": []}
    cuts_out = []
    for cut in season.cuts:
        s = _seed(cut.as_of)
        ctx = prepare(cut, p, season.league, s)
        figs = figures(ctx, p, s)
        w = np.concatenate([np.ones((1, len(cut.weeks))), draws[keep][:, cut.weeks]])
        line: dict[str, Any] = {"as_of": cut.as_of.isoformat()}
        for fmt in FORMATS:
            stats = cut_stats(ctx, figs[fmt], fmt, w)
            per_fmt[fmt].append(stats)
            line[fmt] = {
                "replay": {k: float(v[0]) for k, v in stats["replay"].items()},
                "trades": stats["trades"],
            }
        cuts_out.append(line)
        h = per_fmt["h2h"][-1]
        top = figs["h2h"].picks["top"]
        cache["cuts"].append(
            {
                "as_of": cut.as_of.isoformat(),
                "teams": int(np.prod(ctx.rost.shape[:2])),
                "top_gain": _cat(top, "gain").tolist(),
                "top_realized": realize(ctx, top, "h2h", w[:1]).mine[0].tolist(),
                "value_share": h["sample"]["value_share"].tolist(),
                "market_share": _cat(figs["h2h"].sample, "market_share").tolist(),
                "realized": h["sample"]["realized"][0].tolist(),
            }
        )
    out = {
        "league": season.league,
        "season": season.season,
        "checkpoints": cuts_out,
        "pooled": {fmt: pool(per_fmt[fmt], p) for fmt in FORMATS},
    }
    return out, cache


def _iv(series: np.ndarray) -> list[float]:
    """[point, lo, hi] from row 0 (as it was) and the resamples."""
    return _interval(float(series[0]), series[1:])


def _ols_slope(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """The slope of y [B, K] on x [K], with an intercept, for each row."""
    xc = x - x.mean()
    den = float((xc**2).sum())
    if den <= 0:
        return np.full(len(y), np.nan)
    out: np.ndarray = (y - y.mean(1, keepdims=True)) @ xc / den
    return out


def _masked_mean(values: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Mean of values [B, K, ...] over the entries mask [K, ...] selects, for each row."""
    n = int(mask.sum())
    if not n:
        return np.full(len(values), np.nan)
    out: np.ndarray = (values * mask).reshape(len(values), -1).sum(1) / n
    return out


def pool(parts: list[dict[str, Any]], p: dict[str, Any]) -> dict[str, Any]:
    """The checkpoints together: each replay averaged over the checkpoints (each counts the same),
    the calibration figures over every sampled trade."""
    res: dict[str, Any] = {}
    names = parts[0]["replay"].keys()
    replay = {n: np.mean([c["replay"][n] for c in parts], axis=0) for n in names}
    for kind, base in (("finder", "finder.finder"), ("suggest", "suggest.suggest")):
        if base not in replay:
            continue
        res[f"{kind}_vs_stand_pat"] = _iv(replay[base])
        for n, series in replay.items():
            if n.startswith(f"{kind}.") and n != base:
                res[f"{kind}_vs_{n.split('.', 1)[1]}"] = _iv(replay[base] - series)
        total = np.sum([c["partner"][base][0] for c in parts], axis=0)
        count = sum(c["partner"][base][1] for c in parts)
        res[f"{kind}_partner"] = _iv(total / count) if count else [math.nan] * 3
        res[f"{kind}_trades"] = sum(c["trades"][base] for c in parts)
        res[f"{kind}_teams"] = len(parts)
    s = [c["sample"] for c in parts]
    gain = np.concatenate([x["gain"] for x in s])
    real = np.concatenate([x["realized"] for x in s], axis=1)
    res["sample"] = len(gain)
    res["slope"] = _iv(_ols_slope(gain, real))
    masks = {k: np.concatenate([x[k] for x in s]) for k in ("even", "bad", "terrible", "disagree")}
    masks["bad_or_worse"] = masks["bad"] | masks["terrible"]
    for key, mask in masks.items():
        res[f"{key}_n"] = int(mask.sum())
        res[f"{key}_mean"] = _iv(_masked_mean(real, mask))
    if masks["disagree"].any():
        vs = np.concatenate([x["value_share"] for x in s])
        m = masks["disagree"]
        res["disagree_value_right"] = float((np.sign(real[0][m]) == np.sign(vs[m])).mean())
    dch = np.concatenate([x["dchance"] for x in s])
    cats = np.concatenate([x["cats"] for x in s], axis=1)
    step = float(p["trade.category_change"])
    for key, mask in (("ups", dch >= step), ("downs", -dch >= step)):
        res[f"{key}_n"] = int(mask.sum())
        res[f"{key}_mean"] = _iv(_masked_mean(cats, mask))
    ch = np.concatenate([c["bands"][0].reshape(-1, len(CATS)) for c in parts])
    share = np.concatenate(
        [c["bands"][1].reshape(len(c["bands"][1]), -1, len(CATS)) for c in parts], axis=1
    )
    bands = p["trade.chance_bands"]
    for key, mask in (("conceding", ch < bands["conceding"]), ("locked", ch > bands["locked"])):
        res[f"{key}_n"] = int(mask.sum())
        res[f"{key}_share"] = _iv(_masked_mean(share, mask))
        res[f"{key}_chance"] = float(ch[mask].mean()) if mask.any() else math.nan
    return res


def verdict(result: dict[str, Any], p: dict[str, Any]) -> list[str]:
    """The pass bar declared on #756: what fails, empty when everything passes."""
    fails = []
    rivals = int(p["scale.teams"][result["league"]]) - 1
    for fmt, r in result["pooled"].items():
        m = trade.meaningful_gain(result["league"], p) * (rivals if fmt == "roto" else 1)
        for key, where in (
            ("finder_vs_stand_pat", "the finder vs standing pat"),
            ("finder_vs_naive", "the finder vs the naive manager"),
            ("suggest_vs_stand_pat", "the suggestions vs standing pat"),
            ("suggest_vs_naive", "the suggestions vs the naive manager's package"),
        ):
            v = r.get(key)
            if v is None or not v[1] > 0:
                fails.append(f"{fmt} {where}: {v}")
        for kind in ("finder", "suggest"):
            v = r.get(f"{kind}_partner")
            if v is not None and v[2] < 0:
                fails.append(f"{fmt} the {kind}'s partners lose: {v}")
        sl = r["slope"]
        if not SLOPE[0] <= sl[0] <= SLOPE[1]:
            fails.append(f"{fmt} slope of what happened on the predicted gain {sl[0]:.3f}")
        ev = r["even_mean"]
        if not (-m <= ev[1] and ev[2] <= m):
            fails.append(f"{fmt} trades called even: {ev} not inside +-{m:.3f}")
        if r["bad_or_worse_n"] and not r["bad_or_worse_mean"][2] < 0:
            fails.append(f"{fmt} trades called bad or terrible: {r['bad_or_worse_mean']}")
        if not r["ups_mean"][1] > 0:
            fails.append(f"{fmt} categories listed up: {r['ups_mean']}")
        if not r["downs_mean"][2] < 0:
            fails.append(f"{fmt} categories listed down: {r['downs_mean']}")
        if r["conceding_n"] and not r["conceding_share"][2] < 0.5:
            fails.append(f"{fmt} categories called conceded: {r['conceding_share']}")
        if r["locked_n"] and not r["locked_share"][1] > 0.5:
            fails.append(f"{fmt} categories called locked: {r['locked_share']}")
    return fails


# ---- the fit ---------------------------------------------------------------------------------


def fit(caches: list[dict[str, Any]], p: dict[str, Any]) -> dict[str, Any]:
    """The rule declared on #756, on the tuning seasons only:

    - ``trade.meaningful_gain``: the least gain the finder calls, on a grid of 0 to 0.5, with the
      highest mean realized gain of the finder's top trade (head-to-head; standing pat counts 0),
      each checkpoint weighted equally; ties go to the smaller;
    - the value and market lenses' limits and even bands: from the slope b of what happened on the
      lens's share (through the origin), the share at which the expected change reaches the
      category lens's own bands: even within category_limits.bad x m / b, bad at
      -category_limits.bad x m / b, terrible at -category_limits.terrible x m / b.
    """
    league = caches[0]["league"]
    for c in caches:
        if c["league"] != league or c["season"] not in TUNING[league]:
            msg = (
                f"{c['league']} {c['season']} is not a tuning season ({sorted(TUNING[league])});"
                " the fit reads only those"
            )
            raise SystemExit(msg)
    cuts = [cut for c in caches for cut in c["cuts"]]

    def replay(m: float) -> float:
        return float(
            np.mean(
                [
                    np.sum(np.where(np.array(c["top_gain"]) >= m, c["top_realized"], 0.0))
                    / c["teams"]
                    for c in cuts
                ]
            )
        )

    grid = {m: replay(m) for m in MEANINGFUL_GRID}
    best = min(MEANINGFUL_GRID, key=lambda m: (-round(grid[m], 12), m))
    cl = p["trade.category_limits"]
    out: dict[str, Any] = {
        "league": league,
        "seasons": sorted(c["season"] for c in caches),
        "checkpoints": len(cuts),
        "meaningful_gain": best,
        "replay": {"at_registry": replay(trade.meaningful_gain(league, p)), "at_pick": grid[best]},
        "replay_grid": grid,
    }
    real = np.concatenate([np.array(c["realized"]) for c in cuts])
    for name in ("value", "market"):
        x = np.concatenate([np.array(c[f"{name}_share"], dtype=float) for c in cuts])
        ok = np.isfinite(x)
        if not ok.any():
            out[name] = None
            continue
        b = float((x[ok] * real[ok]).sum() / (x[ok] ** 2).sum())
        if b <= 0:
            out[name] = {"slope": b, "trades": int(ok.sum()), "informative": False}
            continue

        def at(k: float, sign: float, b: float = b) -> float:
            return round(float(np.clip(sign * k * best / b, -1, 1)), 2)

        out[name] = {
            "slope": b,
            "trades": int(ok.sum()),
            "informative": True,
            "even": at(cl["bad"], 1),
            "bad": at(cl["bad"], -1),
            "terrible": at(cl["terrible"], -1),
        }
    return out


# ---- the command line ------------------------------------------------------------------------


def _fmt(v: list[float], f: str = "+.4f") -> str:
    return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"


def _lines(res: dict[str, Any]) -> list[str]:
    lines = []
    for cp in res["checkpoints"]:
        for fmt in FORMATS:
            lines.append(
                f"{cp['as_of']} {fmt}: "
                + ", ".join(
                    f"{k} {v:+.4f} ({cp[fmt]['trades'][k]} trades)"
                    for k, v in cp[fmt]["replay"].items()
                )
            )
    for fmt, r in res["pooled"].items():
        for kind in ("finder", "suggest"):
            lines.append(
                f"{fmt} {kind}, pooled: vs standing pat {_fmt(r[f'{kind}_vs_stand_pat'])}"
                f" ({r[f'{kind}_trades']} trades)"
                + "".join(
                    f"; vs {k[len(kind) + 4 :]} {_fmt(v)}"
                    for k, v in r.items()
                    if k.startswith(f"{kind}_vs_") and k != f"{kind}_vs_stand_pat"
                )
                + f"; the partner {_fmt(r[f'{kind}_partner'])}"
            )
        lines.append(
            f"{fmt} calibration: {r['sample']} sampled trades; slope {_fmt(r['slope'], '.3f')};"
            + "".join(
                f" {k} {_fmt(r[f'{k}_mean'])} (n {r[f'{k}_n']});"
                for k in ("even", "bad", "terrible", "bad_or_worse", "disagree")
            )
            + f" the value lens right in {r.get('disagree_value_right', math.nan):.2f} of"
            " disagreements"
        )
        lines.append(
            f"{fmt} categories: up {_fmt(r['ups_mean'])} (n {r['ups_n']}); down"
            f" {_fmt(r['downs_mean'])} (n {r['downs_n']}); conceded won"
            f" {_fmt(r['conceding_share'], '.3f')} at a chance of {r['conceding_chance']:.3f}"
            f" (n {r['conceding_n']}); locked won {_fmt(r['locked_share'], '.3f')} at"
            f" {r['locked_chance']:.3f} (n {r['locked_n']})"
        )
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge", help="judge one season's checkpoints against the bar")
    j.add_argument("folder", type=Path)
    j.add_argument("--out", type=Path)
    j.add_argument("--cache", type=Path, help="what fit reads, for a tuning season")
    j.add_argument("--judge-locked", action="store_true", help="the held-out season, once")
    f = sub.add_parser("fit", help="fit the thresholds on the tuning seasons' caches")
    f.add_argument("caches", type=Path, nargs="+")
    f.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = standings.registry()
    if args.cmd == "fit":
        res = fit([json.loads(c.read_text(encoding="utf-8")) for c in args.caches], p)
        grid = res.pop("replay_grid")
        print(json.dumps(res, indent=2))
        if args.out:
            res["replay_grid"] = {str(k): v for k, v in grid.items()}
            args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
        return 0
    season = load(args.folder)
    if LOCKED.get(season.league) == season.season and not args.judge_locked:
        print(
            f"{season.league} {season.season} is held out and judged once at the end (#751)",
            file=sys.stderr,
        )
        return 2
    res, cache = judge(season, p)
    for line in _lines(res):
        print(line)
    fails = verdict(res, p)
    res["verdict"] = {"pass": not fails, "fails": fails}
    print(
        "PASS: every condition of the bar holds" if not fails else "FAIL:\n  " + "\n  ".join(fails)
    )
    if args.out:
        args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    if args.cache:
        args.cache.write_text(json.dumps(cache) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
