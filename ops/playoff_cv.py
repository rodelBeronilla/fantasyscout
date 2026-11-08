"""The playoff odds' rework (#900), a lasting share per tally, judged by leaving one tuning season
out.

    uv run python -m ops.playoff_cv cv nba-2020-21/ nba-2021-22/ ... wnba-2023/ --out cv.json
    uv run python -m ops.playoff_cv fit nba-2020-21/ nba-2021-22/ nba-2022-23/

#872 (ADR 0025) judged the odds with one lasting share, ``playoffs.season_share``, for both
tallies: the matchups tally came out too timid and the categories tally too sure in places. The
rework fits each tally's share alone. The seasons #872 judged showed that failure, so they are
spent for this parameter, and the locked seasons stay reserved for the epic's final hold-out. The
evidence is therefore cross-validated within the tuning seasons, as declared on #900 (and as #866
was, ADR 0022): one fold per season, each fitting everything the odds read that a backtest fitted
on the other two seasons of its league, and judging the season held out by #872's bar.

- **The fold's fit:** ``standings.spread_scale`` by #755's rule (the lowest mean head-to-head log
  loss over the training checkpoints, ties nearer 1); then, at that scale, each tally's share on
  #872's grid by the lowest mean log loss of that tally's odds over the training checkpoints
  (ties smaller). The one share, #872's rule refitted in the same fold, is reported beside it.
- **Not refitted:** ``standings.game_spread``, an ad hoc measurement (ADR 0015), not a backtest
  fit.
- **The judgement:** ops.playoff_backtest's leagues, odds, outcomes, baselines and resamples. A
  fold passes when both tallies meet #872's bar at every checkpoint of its held-out season; the
  rework passes when 5 of the 6 folds do and the six held-out seasons pooled do too.

``fit`` is the same rule on all three tuning seasons of a league: what would ship. The odds over
the grid are the slow part, so they run in ``--workers`` processes.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from collections.abc import Iterable
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ops import playoff_backtest as pb
from ops import standings, standings_backtest
from ops.standings import CATS
from ops.standings_backtest import (
    SCALES,
    TUNING,
    Season,
    _interval,
    _logit,
    _seed,
    beat,
    cat_values,
    logistic_slope,
    pairs,
    simulate,
)

TALLIES = pb.TALLIES
# declared on #900 before any run: #872's grid and bar
SHARES = pb.SHARES


# ---- the head-to-head cases the spread scale is fitted on (#755's rule) -----------------------


def h2h_cases(season: Season, p: dict[str, Any]) -> list[tuple[np.ndarray, np.ndarray, Any, float]]:
    """Each checkpoint's pair gaps, players a team, head-to-head weeks won and weeks, on the weeks
    from the checkpoint on (ops.playoff_backtest's cuts hold the whole season)."""
    out = []
    for cut in season.cuts:
        mine = [i for i, d in enumerate(season.weeks) if d >= cut.as_of]
        c = dataclasses.replace(cut, x=cut.x[mine], weeks=np.array(mine, dtype=int))
        lg = simulate(c, p, season.league, _seed(cut.as_of))
        i, j = pairs(lg.rost.shape[1])
        o = beat(cat_values(lg.xt)[:, :, i], cat_values(lg.xt)[:, :, j])
        out.append((lg.tot[:, i] - lg.tot[:, j], lg.n, o.sum(0), float(o.shape[0])))
    return out


def fit_scale(
    league: str, cases: Iterable[tuple[np.ndarray, np.ndarray, Any, float]], p: dict[str, Any]
) -> float:
    flat = list(cases)

    def loss(k: float) -> float:
        return float(
            np.mean(
                [
                    standings_backtest._log_loss(
                        standings.chance(
                            gap, standings.spreads(league, CATS, n, "h2h", p=p, scale=k)[:, None]
                        ),
                        wins,
                        weeks,
                    )
                    for gap, n, wins, weeks in flat
                ]
            )
        )

    grid = {k: loss(k) for k in SCALES}
    return min(SCALES, key=lambda k: (round(grid[k], 12), abs(k - 1)))


# ---- the odds over the grid, in worker processes ---------------------------------------------

_WORKER: dict[str, Any] = {}


def _init(folders: list[str], p: dict[str, Any]) -> None:
    _WORKER["seasons"] = [pb.load(Path(f)) for f in folders]
    _WORKER["p"] = p


def _odds_task(task: tuple[int, int, float, float]) -> tuple[Any, ...]:
    """One season's checkpoint at one (scale, share): each tally's odds, and the share-free figures
    (who made it, the baselines, the weeks) at share 0."""
    s, c, scale, share = task
    season = _WORKER["seasons"][s]
    figs = pb.checkpoint(season.cuts[c], season.weeks, _WORKER["p"], season.league, share, scale)
    odds = {t: f.odds for t, f in figs.items()}
    return task, odds, (figs if share == SHARES[0] else None)


@dataclass
class Grid:
    """Every season's odds over the grid, and its share-free figures, checkpoint by checkpoint."""

    seasons: list[Season]
    base: list[list[dict[str, pb.Figures]]]  # [season][cut][tally]
    made: list[list[dict[str, np.ndarray]]]
    odds: dict[tuple[int, int, float, float], dict[str, np.ndarray]]  # (s, c, scale, share)

    def loss(self, s: int, scale: float, share: float, tally: str, sims: int) -> list[float]:
        return [
            pb.log_loss(self.odds[(s, c, scale, share)][tally], self.made[s][c][tally], sims)
            for c in range(len(self.seasons[s].cuts))
        ]


def build_grid(
    folders: list[Path], seasons: list[Season], scales: dict[int, set[float]], p: dict[str, Any],
    workers: int,
) -> Grid:  # fmt: skip
    tasks = [
        (s, c, k, share)
        for s, season in enumerate(seasons)
        for k in sorted(scales[s])
        for c in range(len(season.cuts))
        for share in SHARES
    ]
    odds: dict[tuple[int, int, float, float], dict[str, np.ndarray]] = {}
    base: dict[tuple[int, int], dict[str, pb.Figures]] = {}
    with ProcessPoolExecutor(
        max_workers=workers, initializer=_init, initargs=([str(f) for f in folders], p)
    ) as ex:
        for done, (task, o, figs) in enumerate(ex.map(_odds_task, tasks), 1):
            odds[task] = o
            if figs is not None:
                base.setdefault(task[:2], figs)
            if done % 20 == 0 or done == len(tasks):
                print(f"odds over the grid: {done} of {len(tasks)}", flush=True)
    b = [[base[(s, c)] for c in range(len(x.cuts))] for s, x in enumerate(seasons)]
    made = [[{t: f.made() for t, f in cut.items()} for cut in row] for row in b]
    return Grid(seasons, b, made, odds)


# ---- the rule ---------------------------------------------------------------------------------


def fit_shares(grid: Grid, train: list[int], scale: float, sims: int) -> dict[str, Any]:
    """Each tally's share alone, and the one share for both (#872's rule), on ``train``."""

    def mean(share: float, tallies: tuple[str, ...]) -> float:
        return float(
            np.mean(
                [x for s in train for t in tallies for x in grid.loss(s, scale, share, t, sims)]
            )
        )

    def pick(tallies: tuple[str, ...]) -> tuple[float, dict[float, float]]:
        g = {share: mean(share, tallies) for share in SHARES}
        return min(SHARES, key=lambda k: (round(g[k], 12), k)), g

    out: dict[str, Any] = {"scale": scale, "share": {}, "grid": {}}
    for t in TALLIES:
        out["share"][t], g = pick((t,))
        out["grid"][t] = {str(k): v for k, v in g.items()}
    out["one_share"], g = pick(TALLIES)
    out["grid"]["both"] = {str(k): v for k, v in g.items()}
    return out


# ---- judging a held-out season ---------------------------------------------------------------


@dataclass
class Held:
    """One held-out checkpoint and tally: the point Briers, their resamples, the slope's inputs."""

    point: dict[str, float]
    boots: list[dict[str, float]]
    x: np.ndarray
    made: np.ndarray
    made_boot: list[np.ndarray]


def held(f: pb.Figures, draws: np.ndarray, sims: int) -> Held:
    made = f.made()
    return Held(
        point=pb._brier(f, made),
        boots=[pb._brier(f, f.made(c)) for c in draws],
        x=_logit(pb._clip(f.odds, sims)).ravel(),
        made=made.ravel(),
        made_boot=[f.made(c).ravel() for c in draws[:: pb.SLOPE_EVERY]],
    )


def figures(h: list[Held]) -> dict[str, Any]:
    """One checkpoint and tally, over one held-out season or several pooled: a Brier gap is the
    mean of the seasons' gaps, its resamples drawn together; the slope is one fit over them all."""
    out: dict[str, Any] = {
        "brier": {k: float(np.mean([x.point[k] for x in h])) for k in h[0].point}
    }
    for base in ("coin", "naive"):
        point = float(np.mean([x.point[base] - x.point["model"] for x in h]))
        n = min(len(x.boots) for x in h)
        boot = np.mean([[b[base] - b["model"] for b in x.boots[:n]] for x in h], axis=0)
        out[f"brier_vs_{base}"] = _interval(point, boot)
    x = np.concatenate([e.x for e in h])
    n = min(len(e.made_boot) for e in h)
    boots = [logistic_slope(x, np.concatenate([e.made_boot[b] for e in h])) for b in range(n)]
    out["slope"] = _interval(
        logistic_slope(x, np.concatenate([e.made for e in h])), np.array(boots)
    )
    return out


def judge_season(
    grid: Grid, s: int, scale: float, share: dict[str, float], p: dict[str, Any]
) -> list[dict[str, Held]]:
    """The held-out season at the fold's fit, with ops.playoff_backtest.judge's resamples."""
    sims = int(p["playoffs.simulations"])
    rng = np.random.default_rng(0)
    out = []
    for c, base in enumerate(grid.base[s]):
        remaining = base[TALLIES[0]].weekly[0].shape[0]
        draws = rng.multinomial(
            remaining, np.full(remaining, 1 / max(remaining, 1)), size=int(p["backtest.bootstrap"])
        ).astype(float)
        out.append(
            {
                t: held(
                    dataclasses.replace(base[t], odds=grid.odds[(s, c, scale, share[t])][t]),
                    draws,
                    sims,
                )
                for t in TALLIES
            }
        )
    return out


def _checkpoints(as_of: list[str], h: list[list[dict[str, Held]]]) -> list[dict[str, Any]]:
    return [
        {"as_of": a, **{t: figures([season[c][t] for season in h]) for t in TALLIES}}
        for c, a in enumerate(as_of)
    ]


def _check(seasons: list[Season]) -> dict[str, list[int]]:
    by_league: dict[str, list[int]] = {}
    for i, s in enumerate(seasons):
        if s.season not in TUNING[s.league]:
            msg = (
                f"{s.league} {s.season} is not a tuning season ({sorted(TUNING[s.league])});"
                " this judgement reads only those"
            )
            raise SystemExit(msg)
        by_league.setdefault(s.league, []).append(i)
    return by_league


def cv(folders: list[Path], p: dict[str, Any], workers: int) -> dict[str, Any]:
    """Leave one season out, within each league's tuning seasons."""
    seasons = [pb.load(f) for f in folders]
    by_league = _check(seasons)
    sims = int(p["playoffs.simulations"])
    cases = [h2h_cases(s, p) for s in seasons]
    scale_of: dict[int, float] = {}  # each fold's, by the season it holds out
    scales: dict[int, set[float]] = {i: set() for i in range(len(seasons))}
    for league, group in by_league.items():
        for held_out in group:
            train = [i for i in group if i != held_out]
            k = fit_scale(league, (c for i in train for c in cases[i]), p)
            scale_of[held_out] = k
            for i in group:
                scales[i].add(k)
    grid = build_grid(folders, seasons, scales, p, workers)
    folds: list[dict[str, Any]] = []
    held_all = []
    for league, group in sorted(by_league.items()):
        for held_out in sorted(group, key=lambda i: seasons[i].season):
            train = [i for i in group if i != held_out]
            fitted = fit_shares(grid, train, scale_of[held_out], sims)
            h = judge_season(grid, held_out, fitted["scale"], fitted["share"], p)
            one = judge_season(
                grid, held_out, fitted["scale"], pb.shares_of(fitted["one_share"]), p
            )
            as_of = [c.as_of.isoformat() for c in seasons[held_out].cuts]
            cps = _checkpoints(as_of, [h])
            fold: dict[str, Any] = {
                "league": league,
                "held_out": seasons[held_out].season,
                "fitted": fitted,
                "checkpoints": cps,
                "one_share": _checkpoints(as_of, [one]),
                "log_loss": {
                    t: {
                        "per_tally": float(
                            np.mean(
                                grid.loss(held_out, fitted["scale"], fitted["share"][t], t, sims)
                            )
                        ),
                        "one_share": float(
                            np.mean(
                                grid.loss(held_out, fitted["scale"], fitted["one_share"], t, sims)
                            )
                        ),
                    }
                    for t in TALLIES
                },
                "fails": pb.verdict({"checkpoints": cps}),
            }
            folds.append(fold)
            held_all.append(h)
            print(_fold_line(fold), flush=True)
    n_cuts = min(len(h) for h in held_all)
    pooled = _checkpoints(
        [f"checkpoint {c + 1}" for c in range(n_cuts)], [h[:n_cuts] for h in held_all]
    )
    pooled_fails = pb.verdict({"checkpoints": pooled})
    passed = sum(not f["fails"] for f in folds)
    log_loss = {
        t: {
            k: float(np.mean([f["log_loss"][t][k] for f in folds]))
            for k in ("per_tally", "one_share")
        }
        for t in TALLIES
    }
    return {
        "folds": folds,
        "pooled": pooled,
        "pooled_fails": pooled_fails,
        "pooled_log_loss": log_loss,
        "folds_passed": passed,
        "pass": passed >= len(folds) - 1 and not pooled_fails,
    }


def fit(folders: list[Path], p: dict[str, Any], workers: int) -> dict[str, Any]:
    """The rule on all three tuning seasons of each league: what would ship."""
    seasons = [pb.load(f) for f in folders]
    by_league = _check(seasons)
    sims = int(p["playoffs.simulations"])
    scale_of = {
        league: fit_scale(league, (c for i in group for c in h2h_cases(seasons[i], p)), p)
        for league, group in by_league.items()
    }
    scales = {i: {scale_of[s.league]} for i, s in enumerate(seasons)}
    grid = build_grid(folders, seasons, scales, p, workers)
    return {
        league: {
            "seasons": sorted(seasons[i].season for i in group),
            **fit_shares(grid, group, scale_of[league], sims),
        }
        for league, group in sorted(by_league.items())
    }


# ---- the command line ------------------------------------------------------------------------


def _iv(v: list[float], f: str = "+.4f") -> str:
    return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"


def _cp_line(cp: dict[str, Any], tally: str) -> str:
    r = cp[tally]
    b = r["brier"]
    return (
        f"  {cp['as_of']} {tally}: Brier model {b['model']:.4f}, naive {b['naive']:.4f}, coin"
        f" {b['coin']:.4f}; vs coin {_iv(r['brier_vs_coin'])}, vs naive"
        f" {_iv(r['brier_vs_naive'])}; slope {_iv(r['slope'], '.3f')}"
    )


def _fold_line(f: dict[str, Any]) -> str:
    fit_ = f["fitted"]
    head = (
        f"{f['league']} {f['held_out']} held out: scale {fit_['scale']}, share categories"
        f" {fit_['share']['categories']}, matchups {fit_['share']['matchups']} (one share"
        f" {fit_['one_share']})"
    )
    lines = [_cp_line(cp, t) for cp in f["checkpoints"] for t in TALLIES]
    one = [
        f"  one share, {cp['as_of']} {t}: slope {_iv(cp[t]['slope'], '.3f')}"
        for cp in f["one_share"]
        for t in TALLIES
    ]
    tail = "  PASS" if not f["fails"] else "  FAIL: " + "; ".join(f["fails"])
    return "\n".join([head, *lines, *one, tail])


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
        s.add_argument("--workers", type=int, default=min(32, os.cpu_count() or 1))
    args = parser.parse_args(argv)
    p = standings.registry()
    if args.cmd == "fit":
        res = fit(args.folders, p, args.workers)
        print(json.dumps(res, indent=2))
    else:
        res = cv(args.folders, p, args.workers)
        print("pooled over the held-out seasons:")
        for cp in res["pooled"]:
            for t in TALLIES:
                print(_cp_line(cp, t))
        pooled = "passes" if not res["pooled_fails"] else "fails: " + "; ".join(res["pooled_fails"])
        print(f"{res['folds_passed']} of {len(res['folds'])} folds pass; pooled {pooled}")
        print(f"held-out log loss: {json.dumps(res['pooled_log_loss'])}")
        print("PASS" if res["pass"] else "FAIL")
    if args.out:
        args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
