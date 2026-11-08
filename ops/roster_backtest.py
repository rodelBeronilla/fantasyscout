"""Walk-forward backtest of My Team's roster review (#757): the drop rule, the minimum gain and
the trade chips, judged on simulated leagues of real seasons.

    uv run python -m ops.walk_forward --league nba --season 2023-24 --standings-out standings/
    uv run python -m ops.roster_backtest judge standings/ --out roster.json --cache cache.json
    uv run python -m ops.roster_backtest fit tuning-2020-21.json tuning-2021-22.json ...

The leagues are #755's (ops.standings_backtest.simulate): at each checkpoint, snake drafts of
the default size, every player active for the rest of the season. Each team reviews its roster as
My Team does (ops/roster.py, pinned to web/src/lib/roster-upgrades.ts): the best free agent
against the lowest-valued player the drop rule lets go, a swap when it gains
``roster.min_gain`` of rest-of-season value. The rule protects a player the board or the market
ranks among the league's starters; with no past ESPN market, the market's rank is the preseason
draft order.

Judged, per format and pooled over the checkpoints, by decision replay: each team makes the
review's swap, or not, against standing pat, the naive manager (drop the lowest season-so-far
average for the best free agent by it) and the review without the drop rule. A trade chip (a
protected player the best free agent beats by the minimum gain) is judged by what dropping it
for that free agent would have done. The outcome is the team's realized change over the rest of
the season, from the real box scores: categories won a week against every other team, or
rotisserie points, the other rosters as they were.

Intervals are 95%, from ``backtest.bootstrap`` resamples of the season's weeks, as in #755. The
pass bar was declared on #757 before any run; ``verdict`` applies it. ``fit`` reads the tuning
seasons' caches only.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ops import roster, standings
from ops.standings_backtest import (
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
ARMS = ("review", "naive", "no_rule")
SHARE_GRID = tuple(round(0.05 * i, 2) for i in range(21))
GAIN_GRID = tuple(round(0.1 * i, 1) for i in range(51))
CHUNK = 50


def web_rest(cut: Cut) -> np.ndarray:
    """The web's rest-of-season value in a default league (team-review.ts teamValues): the nine
    categories' sum plus the market prior's shift (league-value.ts marketPriorShift, #848), its
    positive part scaled by games share and ros_factor (scaleValue)."""
    own = cut.z.sum(1)
    weight = np.nan_to_num(cut.columns.get("market_prior_weight", np.zeros(len(own))), nan=0.0)
    market = cut.columns.get("market_prior_value", np.full(len(own), np.nan))
    shift = np.where((weight > 0) & np.isfinite(market), weight * (np.nan_to_num(market) - own), 0)
    v = own + shift
    out: np.ndarray = np.where(v > 0, v * cut.games_share * cut.ros_factor, v)
    return out


@dataclass
class Ctx:
    league: str
    rost: np.ndarray  # [L, T, R]
    xt: np.ndarray  # [W, L, T, 11]
    x: np.ndarray  # [W, P, 11]
    rest: np.ndarray  # [P]
    naive: np.ndarray  # [P] season-so-far value per game
    protect_rank: np.ndarray  # [P] the better of the board's and the market's rank (inf: none)
    free: np.ndarray  # [L, P] bool, on no roster in the league
    teams: int
    spots: int


def prepare(cut: Cut, p: dict[str, Any], league: str, seed: int) -> Ctx:
    lg = simulate(cut, p, league, seed)
    players = len(cut.z)
    free = np.ones((len(lg.rost), players), dtype=bool)
    np.put_along_axis(free, lg.rost.reshape(len(lg.rost), -1), False, axis=1)
    board = np.nan_to_num(cut.columns.get("rank_total", np.full(players, np.nan)), nan=np.inf)
    market = np.nan_to_num(cut.adp, nan=np.inf)
    return Ctx(
        league=league,
        rost=lg.rost,
        xt=lg.xt,
        x=cut.x,
        rest=web_rest(cut),
        naive=cut.naive.sum(1),
        protect_rank=np.minimum(board, market),
        free=free,
        teams=lg.rost.shape[1],
        spots=lg.rost.shape[2],
    )


def starters(teams: int, spots: int, share: float) -> int:
    return teams * math.ceil(spots * share)


def swaps(ctx: Ctx, share: float | None) -> dict[str, np.ndarray]:
    """Each team's swap [L, T]: the best free agent by rest-of-season value, and the lowest-valued
    player the drop rule lets go (``share`` None: anyone may go); the gain; and the trade chips'
    mask [L, T, R]. suggestUpgrades' first swap is this pair: the largest gain."""
    rest = ctx.rest
    order = np.argsort(-rest, kind="stable")
    best = np.array([order[f[order]][0] for f in ctx.free])  # [L]
    r = rest[ctx.rost]  # [L, T, R]
    if share is None:
        keep = np.zeros_like(r, dtype=bool)
    else:
        keep = ctx.protect_rank[ctx.rost] <= starters(ctx.teams, ctx.spots, share)
    # the lowest droppable, the first of equals in the roster's order (sorted by value, stable)
    masked = np.where(keep, np.inf, r)
    low = np.argmin(masked, axis=-1)
    none = np.isinf(np.take_along_axis(masked, low[..., None], -1)[..., 0])
    drop = np.take_along_axis(ctx.rost, low[..., None], -1)[..., 0]
    add = np.broadcast_to(best[:, None], drop.shape)
    # the review adds only a free agent worth more than replacement
    worth = (rest[best] > 0)[:, None]
    gain = np.where(none | ~worth, -np.inf, rest[add] - rest[drop])
    chips_gain = np.where(worth[..., None], rest[best][:, None, None] - r, -np.inf)
    return {"add": add, "drop": drop, "gain": gain, "keep": keep, "chip_gain": chips_gain}


def naive_swap(ctx: Ctx) -> dict[str, np.ndarray]:
    """The naive manager: the lowest season-so-far average on the roster for the best free agent
    by it, when that is better."""
    order = np.argsort(-ctx.naive, kind="stable")
    best = np.array([order[f[order]][0] for f in ctx.free])
    low = np.argmin(ctx.naive[ctx.rost], axis=-1)
    drop = np.take_along_axis(ctx.rost, low[..., None], -1)[..., 0]
    add = np.broadcast_to(best[:, None], drop.shape)
    return {"add": add, "drop": drop, "made": ctx.naive[add] > ctx.naive[drop]}


# ---- what happened ---------------------------------------------------------------------------


def _won(mine: np.ndarray, others: np.ndarray, off: np.ndarray) -> np.ndarray:
    """Categories each team [..., L, T, 9] beats each other team in, summed: [..., L, T]."""
    b = beat(mine[..., :, :, None, :], others[..., :, None, :, :]) * off[..., None]
    out: np.ndarray = b.sum((-2, -1))
    return out


def realized(ctx: Ctx, add: np.ndarray, drop: np.ndarray, fmt: str, w: np.ndarray) -> np.ndarray:
    """Each team's realized change [B, L, T] from swapping ``drop`` for ``add`` ([L, T]), the
    other rosters as they were, for each weighting of the weeks w [B, W] (row 0: as it was).
    Head-to-head: categories won a week against every other team, averaged over them;
    rotisserie: points on the weighted season's totals."""
    teams = ctx.teams
    off = ~np.eye(teams, dtype=bool)
    new = ctx.xt + ctx.x[:, add] - ctx.x[:, drop]  # [W, L, T, 11] each team's own swap
    if fmt == "h2h":
        cv = cat_values(ctx.xt)
        delta = (_won(cat_values(new), cv, off) - _won(cv, cv, off)) / (teams - 1)  # [W, L, T]
        tot = w.sum(1)
        out: np.ndarray = (
            np.einsum("bw,wlt->blt", w, delta) / np.where(tot > 0, tot, 1)[:, None, None]
        )
        return out
    parts = []
    for s in range(0, len(w), CHUNK):
        c = w[s : s + CHUNK]
        cv = cat_values(np.einsum("bw,wltf->bltf", c, ctx.xt))
        cn = cat_values(np.einsum("bw,wltf->bltf", c, new))
        parts.append(_won(cn, cv, off) - _won(cv, cv, off))
    return np.concatenate(parts)


# ---- judging ---------------------------------------------------------------------------------


def judge(
    season: Season, p: dict[str, Any], *, seed: int = 0
) -> tuple[dict[str, Any], dict[str, Any]]:
    resamples = int(p["backtest.bootstrap"])
    rng = np.random.default_rng(seed)
    draws = rng.multinomial(
        len(season.weeks), np.full(len(season.weeks), 1 / len(season.weeks)), size=resamples
    ).astype(float)
    keep = np.all([draws[:, c.weeks].sum(1) > 0 for c in season.cuts], axis=0)
    share = roster.per_league(p, "roster.starter_share", season.league)
    least = roster.per_league(p, "roster.min_gain", season.league)
    per: dict[str, list[dict[str, Any]]] = {f: [] for f in FORMATS}
    cache: dict[str, Any] = {"league": season.league, "season": season.season, "cuts": []}
    lines = []
    for cut in season.cuts:
        ctx = prepare(cut, p, season.league, _seed(cut.as_of))
        w = np.concatenate([np.ones((1, len(cut.weeks))), draws[keep][:, cut.weeks]])
        rule, free_for_all, naive = swaps(ctx, share), swaps(ctx, None), naive_swap(ctx)
        line: dict[str, Any] = {"as_of": cut.as_of.isoformat()}
        # the cache: each share's swap and its realized head-to-head change, for the fit
        grid = {}
        for s in SHARE_GRID:
            sw = swaps(ctx, s)
            grid[str(s)] = {
                "gain": np.where(np.isfinite(sw["gain"]), sw["gain"], -1e9).ravel().tolist(),
                "realized": realized(ctx, sw["add"], sw["drop"], "h2h", w[:1])[0].ravel().tolist(),
            }
        cache["cuts"].append({"as_of": cut.as_of.isoformat(), "grid": grid})
        for fmt in FORMATS:
            r_rule = realized(ctx, rule["add"], rule["drop"], fmt, w)
            r_free = realized(ctx, free_for_all["add"], free_for_all["drop"], fmt, w)
            r_naive = realized(ctx, naive["add"], naive["drop"], fmt, w)
            made = rule["gain"] >= least
            arms = {
                "review": np.where(made, r_rule, 0.0),
                "no_rule": np.where(free_for_all["gain"] >= least, r_free, 0.0),
                "naive": np.where(naive["made"], r_naive, 0.0),
            }
            # the chips: each team's lowest-valued chip swapped for the best free agent
            chip = rule["keep"] & (rule["chip_gain"] >= least)
            has = chip.any(-1)
            r = ctx.rest[ctx.rost]
            pos = np.argmin(np.where(chip, r, np.inf), axis=-1)
            chip_id = np.take_along_axis(ctx.rost, pos[..., None], -1)[..., 0]
            r_chip = realized(ctx, rule["add"], chip_id, fmt, w)
            per[fmt].append(
                {
                    "arms": {k: v.reshape(len(w), -1).mean(1) for k, v in arms.items()},
                    "made": {
                        k: int(m.sum())
                        for k, m in (
                            ("review", made),
                            ("naive", naive["made"]),
                            ("no_rule", free_for_all["gain"] >= least),
                        )
                    },
                    "chips": (r_chip.reshape(len(w), -1)[:, has.ravel()], int(has.sum())),
                    "swapped": (r_rule.reshape(len(w), -1)[:, made.ravel()], int(made.sum())),
                    "teams": int(made.size),
                }
            )
            line[fmt] = {k: float(v[0]) for k, v in per[fmt][-1]["arms"].items()}
            line[fmt]["swaps"] = per[fmt][-1]["made"]
            line[fmt]["chips"] = int(has.sum())
        lines.append(line)
    return (
        {
            "league": season.league,
            "season": season.season,
            "checkpoints": lines,
            "pooled": {f: pool(per[f]) for f in FORMATS},
        },
        cache,
    )


def _iv(series: np.ndarray) -> list[float]:
    return _interval(float(series[0]), series[1:])


def pool(parts: list[dict[str, Any]]) -> dict[str, Any]:
    arms = {a: np.mean([c["arms"][a] for c in parts], axis=0) for a in ARMS}
    res: dict[str, Any] = {"review_vs_stand_pat": _iv(arms["review"])}
    for a in ("naive", "no_rule"):
        res[f"review_vs_{a}"] = _iv(arms["review"] - arms[a])
        res[f"{a}_vs_stand_pat"] = _iv(arms[a])
    for key in ("chips", "swapped"):
        vals = np.concatenate([c[key][0] for c in parts], axis=1)
        n = sum(c[key][1] for c in parts)
        res[f"{key}_n"] = n
        res[f"{key}_mean"] = _iv(vals.mean(1)) if n else [math.nan] * 3
    res["swaps"] = {a: sum(c["made"][a] for c in parts) for a in ARMS}
    res["teams"] = sum(c["teams"] for c in parts)
    return res


def verdict(result: dict[str, Any]) -> list[str]:
    """The pass bar declared on #757: what fails, empty when everything passes."""
    fails = []
    for fmt, r in result["pooled"].items():
        for key, beat_it in (
            ("review_vs_stand_pat", True),
            ("review_vs_naive", True),
            ("review_vs_no_rule", False),
        ):
            v = r[key]
            if (not v[1] > 0) if beat_it else v[2] < 0:
                fails.append(f"{fmt} {key}: {v}")
        if r["chips_n"] and not r["chips_mean"][2] < 0:
            fails.append(f"{fmt} dropping a trade chip for the best free agent: {r['chips_mean']}")
    return fails


# ---- the fit ---------------------------------------------------------------------------------


def fit(caches: list[dict[str, Any]], p: dict[str, Any]) -> dict[str, Any]:
    """The rule declared on #757, on the tuning seasons only: ``roster.starter_share`` with the
    highest mean realized head-to-head change of the review's swaps over the tuning checkpoints
    (each counting the same) at the registered minimum gain, ties to the larger share; then
    ``roster.min_gain`` the same way with that share, ties to the smaller gain."""
    league = caches[0]["league"]
    for c in caches:
        if c["league"] != league or c["season"] not in TUNING[league]:
            msg = (
                f"{c['league']} {c['season']} is not a tuning season ({sorted(TUNING[league])});"
                " the fit reads only those"
            )
            raise SystemExit(msg)
    cuts = [cut for c in caches for cut in c["cuts"]]

    def replay(share: float, least: float) -> float:
        return float(
            np.mean(
                [
                    np.mean(
                        np.where(
                            np.array(cut["grid"][str(share)]["gain"]) >= least,
                            cut["grid"][str(share)]["realized"],
                            0.0,
                        )
                    )
                    for cut in cuts
                ]
            )
        )

    reg = roster.per_league(p, "roster.min_gain", league)
    by_share = {s: replay(s, reg) for s in SHARE_GRID}
    share = min(SHARE_GRID, key=lambda s: (-round(by_share[s], 12), -s))
    by_gain = {g: replay(share, g) for g in GAIN_GRID}
    least = min(GAIN_GRID, key=lambda g: (-round(by_gain[g], 12), g))
    return {
        "league": league,
        "seasons": sorted(c["season"] for c in caches),
        "checkpoints": len(cuts),
        "starter_share": share,
        "min_gain": least,
        "replay": {
            "at_registry": replay(roster.per_league(p, "roster.starter_share", league), reg),
            "at_pick": by_gain[least],
        },
        "share_grid": {str(k): v for k, v in by_share.items()},
        "gain_grid": {str(k): v for k, v in by_gain.items()},
    }


# ---- the command line ------------------------------------------------------------------------


def _fmt(v: list[float], f: str = "+.4f") -> str:
    return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"


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
    f = sub.add_parser("fit", help="fit the drop rule's share and the minimum gain")
    f.add_argument("caches", type=Path, nargs="+")
    f.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = standings.registry()
    if args.cmd == "fit":
        res = fit([json.loads(c.read_text(encoding="utf-8")) for c in args.caches], p)
        print(json.dumps({k: v for k, v in res.items() if not k.endswith("_grid")}, indent=2))
        if args.out:
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
    for cp in res["checkpoints"]:
        for fmt in FORMATS:
            print(f"{cp['as_of']} {fmt}: {cp[fmt]}")
    for fmt, r in res["pooled"].items():
        print(
            f"{fmt}, pooled: review vs standing pat {_fmt(r['review_vs_stand_pat'])};"
            f" vs naive {_fmt(r['review_vs_naive'])}; vs no rule {_fmt(r['review_vs_no_rule'])};"
            f" naive vs standing pat {_fmt(r['naive_vs_stand_pat'])}; swaps {r['swaps']} of"
            f" {r['teams']} teams; a swap made {_fmt(r['swapped_mean'])} (n {r['swapped_n']});"
            f" a chip dropped {_fmt(r['chips_mean'])} (n {r['chips_n']})"
        )
    fails = verdict(res)
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
