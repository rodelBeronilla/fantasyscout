"""The rotisserie win chances' rework (#866), judged by leaving one tuning season out.

    uv run python -m ops.roto_backtest cv nba-2020-21/ nba-2021-22/ nba-2022-23/ --out cv.json
    uv run python -m ops.roto_backtest fit nba-2020-21/ nba-2021-22/ nba-2022-23/

#755 (ADR 0021) found the rotisserie chances too timid at the first game day, with one projection
spread for every horizon. The rework splits a projection's error in two (ops.standings.spreads):
a part that lasts however many games are left (``standings.projection_spread``, a) and one whose
variance falls with them (b, the ``projection_games`` of ops.standings.spreads): p(g)² = a² + b² ÷
g. It failed (ADR 0022): b came out 0 in every fold, so the web keeps the constant spread.

The seasons #755 judged showed that failure, so they are spent for this parameter; the locked
seasons stay reserved for the epic's final hold-out. The evidence is therefore cross-validated
within the tuning seasons, as declared on #866: one fold per season, each fitting everything the
rotisserie chance reads (``standings.spread_scale``, then a and b) on the other two seasons of its
league and judging the season held out, against a coin flip, the naive manager and Constant (b =
0, refitted in the same fold). The leagues, drafts and checkpoints are ops.standings_backtest's.
Intervals are 95%, from ``backtest.bootstrap`` resamples of the held-out season's weeks, centred
as there. ``fit`` is the same rule on all three tuning seasons, what would have shipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ops import standings, standings_backtest
from ops.standings import CATS
from ops.standings_backtest import (
    SCALES,
    TUNING,
    Season,
    _interval,
    _log_loss,
    _logit,
    _seed,
    beat,
    cat_values,
    logistic_slope,
    pairs,
    simulate,
)

# declared on #866 before any run
LASTING = tuple(round(0.05 * i, 2) for i in range(31))
PASSING = tuple(round(0.25 * i, 2) for i in range(33))
SLOPE = (0.8, 1.25)
SLOPE_EVERY = 10
MODELS = ("model", "constant", "naive")


@dataclass
class Case:
    """One checkpoint's leagues: the gaps, the players, and what the weeks after it did."""

    gap: np.ndarray  # [L, K, 9]
    naive_gap: np.ndarray
    n: np.ndarray  # [L]
    spots: int
    games_left: float
    xt: np.ndarray  # [W, L, T, 11]
    wins: np.ndarray  # [L, K, 9] head-to-head weeks won, for the spread scale
    weeks: float
    roto: np.ndarray  # [L, K, 9] the rest of the season


def cases(season: Season, p: dict[str, Any]) -> list[Case]:
    out = []
    for cut in season.cuts:
        lg = simulate(cut, p, season.league, _seed(cut.as_of))
        i, j = pairs(lg.rost.shape[1])
        cv = cat_values(lg.xt)
        o = beat(cv[:, :, i], cv[:, :, j])
        total = cat_values(lg.xt.sum(0))
        out.append(
            Case(
                gap=lg.tot[:, i] - lg.tot[:, j],
                naive_gap=lg.naive_tot[:, i] - lg.naive_tot[:, j],
                n=lg.n,
                spots=lg.spots,
                games_left=cut.games_left,
                xt=lg.xt,
                wins=o.sum(0),
                weeks=float(o.shape[0]),
                roto=beat(total[:, i], total[:, j]),
            )
        )
    return out


def _spread(league: str, c: Case, p: dict[str, Any], k: float, a: float, b: float) -> np.ndarray:
    out: np.ndarray = standings.spreads(
        league, CATS, c.n, "roto", c.games_left, p=p, scale=k, projection=a, projection_games=b
    )[:, None, :]
    return out


def fit_rule(league: str, train: list[list[Case]], p: dict[str, Any]) -> dict[str, Any]:
    """The declared rule on the training seasons: the spread scale by #755's rule, then (a, b) by
    the lowest mean rotisserie log loss over the training checkpoints (ties smaller b, then a),
    and Constant's p with b = 0 (ties smaller)."""
    flat = [c for s in train for c in s]

    def h2h(k: float) -> float:
        return float(
            np.mean(
                [
                    _log_loss(
                        standings.chance(
                            c.gap,
                            standings.spreads(league, CATS, c.n, "h2h", p=p, scale=k)[:, None, :],
                        ),
                        c.wins,
                        c.weeks,
                    )
                    for c in flat
                ]
            )
        )

    scale_grid = {k: h2h(k) for k in SCALES}
    scale = min(SCALES, key=lambda k: (round(scale_grid[k], 12), abs(k - 1)))

    def roto(a: float, b: float) -> float:
        return float(
            np.mean(
                [
                    _log_loss(
                        standings.chance(c.gap, _spread(league, c, p, scale, a, b)), c.roto, 1.0
                    )
                    for c in flat
                ]
            )
        )

    grid = {(a, b): roto(a, b) for a in LASTING for b in PASSING}
    a, b = min(grid, key=lambda ab: (round(grid[ab], 12), ab[1], ab[0]))
    constant = min(LASTING, key=lambda q: (round(grid[(q, 0.0)], 12), q))
    return {
        "spread_scale": scale,
        "projection_spread": a,
        "projection_spread_games": b,
        "constant_projection_spread": constant,
        "roto_log_loss": {"model": grid[(a, b)], "constant": grid[(constant, 0.0)]},
    }


# ---- judging a held-out season ---------------------------------------------------------------


def _chances(
    league: str, c: Case, p: dict[str, Any], fitted: dict[str, Any]
) -> dict[str, np.ndarray]:
    k = fitted["spread_scale"]
    a, b = fitted["projection_spread"], fitted["projection_spread_games"]
    naive_n = np.full_like(c.n, c.spots)
    naive = standings.spreads(
        league, CATS, naive_n, "roto", c.games_left, p=p, scale=k, projection=a, projection_games=b
    )[:, None, :]
    return {
        "model": standings.chance(c.gap, _spread(league, c, p, k, a, b)),
        "constant": standings.chance(
            c.gap, _spread(league, c, p, k, fitted["constant_projection_spread"], 0.0)
        ),
        "naive": standings.chance(c.naive_gap, naive),
    }


def _outcome(c: Case, weights: np.ndarray) -> np.ndarray:
    xt = np.tensordot(weights, c.xt, axes=(0, 0))
    cv = cat_values(xt)
    i, j = pairs(xt.shape[1])
    out: np.ndarray = beat(cv[:, i], cv[:, j])
    return out


def _briers(ch: dict[str, np.ndarray], o: np.ndarray) -> dict[str, float]:
    out = {k: float(((v - o) ** 2).mean()) for k, v in ch.items()}
    out["coin"] = float(((0.5 - o) ** 2).mean())
    return out


@dataclass
class Held:
    """A held-out checkpoint: its point Briers, their resamples, and the slope's inputs."""

    point: dict[str, float]
    boots: list[dict[str, float]]
    x: dict[str, np.ndarray]
    o: np.ndarray
    o_boot: list[np.ndarray]


def held_out(
    league: str,
    season: list[Case],
    weeks: int,
    p: dict[str, Any],
    fitted: dict[str, Any],
    seed: int,
) -> list[Held]:
    rng = np.random.default_rng(seed)
    draws = rng.multinomial(
        weeks, np.full(weeks, 1 / weeks), size=int(p["backtest.bootstrap"])
    ).astype(float)
    out = []
    for c in season:
        w = c.xt.shape[0]
        mine = draws[:, weeks - w :]
        ch = _chances(league, c, p, fitted)
        o = _outcome(c, np.ones(w))
        boots = [_briers(ch, _outcome(c, d)) for d in mine if d.sum() > 0]
        o_boot = [_outcome(c, d).ravel() for d in mine[::SLOPE_EVERY] if d.sum() > 0]
        x = {k: _logit(v).ravel() for k, v in ch.items()}
        out.append(Held(_briers(ch, o), boots, x, o.ravel(), o_boot))
    return out


def _gaps(h: list[Held], base: str) -> tuple[float, np.ndarray]:
    """The model's Brier gap over ``base``, mean over held-out seasons, with the resamples drawn
    together (the same resample index in each season)."""
    point = float(np.mean([x.point[base] - x.point["model"] for x in h]))
    n = min(len(x.boots) for x in h)
    boot = np.mean([[b[base] - b["model"] for b in x.boots[:n]] for x in h], axis=0)
    return point, boot


def figures(h: list[Held]) -> dict[str, Any]:
    """One checkpoint, over one held-out season or several pooled."""
    out: dict[str, Any] = {
        "brier": {k: float(np.mean([x.point[k] for x in h])) for k in h[0].point}
    }
    for base in ("coin", "naive", "constant"):
        point, boot = _gaps(h, base)
        out[f"vs_{base}"] = _interval(point, boot)
    for k in ("model", "constant"):
        x = np.concatenate([e.x[k] for e in h])
        o = np.concatenate([e.o for e in h])
        n = min(len(e.o_boot) for e in h)
        boots = [logistic_slope(x, np.concatenate([e.o_boot[b] for e in h])) for b in range(n)]
        out[f"slope_{k}"] = _interval(logistic_slope(x, o), np.array(boots))
    return out


def passes(cps: list[dict[str, Any]]) -> list[str]:
    """The declared bar on one fold or the pool: what fails."""
    fails = []
    for i, cp in enumerate(cps):
        where = cp["as_of"]
        s = cp["slope_model"][0]
        if not SLOPE[0] <= s <= SLOPE[1]:
            fails.append(f"{where}: calibration slope {s:.3f} outside {SLOPE}")
        if not cp["vs_coin"][1] > 0:
            fails.append(f"{where}: does not beat the coin {cp['vs_coin']}")
        naive = cp["vs_naive"]
        if (naive[2] < 0) if i == 0 else not naive[1] > 0:
            fails.append(f"{where}: against the naive manager {naive}")
        if cp["vs_constant"][2] < 0:
            fails.append(f"{where}: worse than Constant {cp['vs_constant']}")
    return fails


def cv(seasons: list[Season], p: dict[str, Any]) -> dict[str, Any]:
    """Leave one season out, within each league's tuning seasons."""
    by_league: dict[str, list[Season]] = {}
    for s in seasons:
        if s.season not in TUNING[s.league]:
            msg = f"{s.league} {s.season} is not a tuning season; this judgement reads only those"
            raise SystemExit(msg)
        by_league.setdefault(s.league, []).append(s)
    folds = []
    held: list[list[Held]] = []
    for league, group in sorted(by_league.items()):
        built = {s.season: cases(s, p) for s in group}
        for s in sorted(group, key=lambda x: x.season):
            train = [built[o.season] for o in group if o.season != s.season]
            fitted = fit_rule(league, train, p)
            h = held_out(league, built[s.season], len(s.weeks), p, fitted, _seed(s.cuts[0].as_of))
            cps = [
                {"as_of": c.as_of.isoformat(), **figures([x])}
                for c, x in zip(s.cuts, h, strict=True)
            ]
            fails = passes(cps)
            folds.append(
                {
                    "league": league,
                    "held_out": s.season,
                    "fitted": fitted,
                    "checkpoints": cps,
                    "fails": fails,
                }
            )
            held.append(h)
            print(_fold_line(folds[-1]), flush=True)
    pooled = [
        {"as_of": f"checkpoint {i + 1}", **figures([h[i] for h in held])}
        for i in range(min(len(h) for h in held))
    ]
    pooled_fails = passes(pooled)
    passed = sum(not f["fails"] for f in folds)
    return {
        "folds": folds,
        "pooled": pooled,
        "pooled_fails": pooled_fails,
        "folds_passed": passed,
        "pass": passed >= len(folds) - 1 and not pooled_fails,
    }


def fit(seasons: list[Season], p: dict[str, Any]) -> dict[str, Any]:
    league = seasons[0].league
    for s in seasons:
        if s.league != league or s.season not in TUNING[league]:
            msg = f"{s.league} {s.season} is not a tuning season ({sorted(TUNING[league])})"
            raise SystemExit(msg)
    return {
        "league": league,
        "seasons": sorted(s.season for s in seasons),
        **fit_rule(league, [cases(s, p) for s in seasons], p),
    }


# ---- the command line ------------------------------------------------------------------------


def _iv(v: list[float], f: str = "+.4f") -> str:
    return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"


def _cp_line(cp: dict[str, Any]) -> str:
    b = cp["brier"]
    return (
        f"  {cp['as_of']}: Brier model {b['model']:.4f}, constant {b['constant']:.4f},"
        f" naive {b['naive']:.4f}, coin {b['coin']:.4f}; vs coin {_iv(cp['vs_coin'])},"
        f" vs naive {_iv(cp['vs_naive'])}, vs constant {_iv(cp['vs_constant'])};"
        f" slope {_iv(cp['slope_model'], '.3f')} (constant {_iv(cp['slope_constant'], '.3f')})"
    )


def _fold_line(f: dict[str, Any]) -> str:
    fit_ = f["fitted"]
    head = (
        f"{f['league']} {f['held_out']} held out: scale {fit_['spread_scale']}, a"
        f" {fit_['projection_spread']}, b {fit_['projection_spread_games']}, constant"
        f" {fit_['constant_projection_spread']}"
    )
    tail = "  PASS" if not f["fails"] else "  FAIL: " + "; ".join(f["fails"])
    return "\n".join([head, *(_cp_line(cp) for cp in f["checkpoints"]), tail])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name, text in (
        ("cv", "leave one tuning season out"),
        ("fit", "fit what ships on the tuning seasons"),
    ):
        s = sub.add_parser(name, help=text)
        s.add_argument("folders", type=Path, nargs="+")
        s.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = standings.registry()
    seasons = [standings_backtest.load(d) for d in args.folders]
    if args.cmd == "fit":
        res = fit(seasons, p)
        print(json.dumps(res, indent=2))
    else:
        res = cv(seasons, p)
        print("pooled over the held-out seasons:")
        for cp in res["pooled"]:
            print(_cp_line(cp))
        pooled = "passes" if not res["pooled_fails"] else "fails: " + "; ".join(res["pooled_fails"])
        print(f"{res['folds_passed']} of {len(res['folds'])} folds pass; pooled {pooled}")
        print("PASS" if res["pass"] else "FAIL")
    if args.out:
        args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
