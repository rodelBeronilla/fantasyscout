"""Walk-forward backtest of a points league's playoff odds (#891, ``pointsPlayoffOdds`` in
web/src/lib/playoff-odds.ts): the weekly fantasy-points margin's spread measured, and the odds
judged against who made the cut on simulated leagues of real seasons.

    uv run python -m ops.walk_forward --league nba --season 2023-24 --standings-out standings/
    uv run python -m ops.points_backtest fit nba-2020-21/ nba-2021-22/ nba-2022-23/
    uv run python -m ops.points_backtest judge standings/ --out points.json

It reads the inputs ops.standings_backtest reads, with the board's projected per-game line
(``proj_*_pg``, exported since #891), and plays #872's leagues (ops.playoff_backtest) as
head-to-head points leagues under ESPN's default scoring:

- **the draft:** #755's snake draft, by projected fantasy points per game;
- **the model:** a team's projection is its players' fantasy points per game times availability;
  a week goes to a side with the chance a normal margin falls its way, around the gap, with a
  spread of ``playoffs.points_spread_share`` of the league's average team; part of the margin
  (``playoffs.points_season_share``) is drawn once a season;
- **what happened:** each team's real fantasy points each fantasy week, the higher total winning,
  over #872's schedule, record so far and cut.

``fit`` reads the tuning seasons only. The spread is measured: at each checkpoint, every week from
it on, every league and pair, r is the week's real margin over the league's average team's real
points that week and mu the projected gap over the league's average projected team; the share is
sqrt(mean (r - mu)^2), each checkpoint weighted equally. The lasting share is then searched on
#872's grid by the lowest mean log loss of the odds. ``judge`` applies #872's bar, as declared on
#891 before any run.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np

from ops import playoff_backtest as pb
from ops import playoffs, standings
from ops.standings_backtest import (
    JUDGED,
    PROJECTED,
    TUNING,
    Cut,
    Season,
    _interval,
    _logit,
    _seed,
    beat,
    draft,
    logistic_slope,
    pairs,
)
from ops.walk_forward import LOCKED

# ESPN's default points scoring (web POINT_PRESETS.espn), in STATS order: points, rebounds,
# assists, steals, blocks, threes, turnovers, FGM, FGA, FTM, FTA
ESPN = np.array([1, 1, 2, 4, 4, 1, -2, 2, -1, 1, -1], dtype=float)
# declared on #891 before any run: #872's grid and bar
SHARES = pb.SHARES
SLOPE = pb.SLOPE
SLOPE_EVERY = pb.SLOPE_EVERY


# ---- the leagues ---------------------------------------------------------------------------


def projected(cut: Cut) -> np.ndarray:
    """Each player's projected fantasy points per game (``fantasyPoints``) [P]."""
    missing = [c for c in PROJECTED if c not in cut.columns]
    if missing:
        msg = f"the export has no {missing[0]}: re-run the walk forward since #891"
        raise SystemExit(msg)
    line = np.column_stack([np.nan_to_num(cut.columns[c]) for c in PROJECTED])
    out: np.ndarray = line @ ESPN
    return out


@dataclass
class League:
    """One checkpoint's points leagues: the projections and every week's real points."""

    tot: np.ndarray  # [L, T] projected points per game, availability-weighted
    points: np.ndarray  # [W, L, T] real fantasy points each week of the season


def simulate(cut: Cut, p: dict[str, Any], league: str) -> League:
    fp = projected(cut)
    rost = draft(
        np.random.default_rng(_seed(cut.as_of)),
        fp,
        int(p["backtest.standings_leagues"]),
        int(p["scale.teams"][league]),
        int(p["scale.roster_spots"][league]),
        int(p["backtest.standings_draft_choice"]),
    )
    weekly = cut.x @ ESPN  # [W, P]
    return League(tot=(fp[rost] * cut.avail[rost]).sum(-1), points=weekly[:, rost].sum(-1))


def spread_terms(lg: League, weeks: np.ndarray) -> np.ndarray:
    """(r - mu)^2 for every week in ``weeks``, league and pair [W, L, K]: the real margin as a share
    of the league's average team that week, less the projected gap as a share of the average
    projected team."""
    i, j = pairs(lg.tot.shape[1])
    pts = lg.points[weeks]
    avg = pts.mean(-1, keepdims=True)
    r = (pts[..., i] - pts[..., j]) / np.where(avg > 0, avg, np.nan)
    mu = (lg.tot[:, i] - lg.tot[:, j]) / lg.tot.mean(-1, keepdims=True)
    out: np.ndarray = (r - mu) ** 2
    return out


def from_cut(season: Season, cut: Cut) -> np.ndarray:
    return np.array([i for i, d in enumerate(season.weeks) if d >= cut.as_of], dtype=int)


# ---- the odds at one checkpoint ---------------------------------------------------------------


def checkpoint(
    cut: Cut, n_weeks: list[Any], p: dict[str, Any], league: str, spread_share: float,
    season_share: float, lg: League | None = None,
) -> pb.Figures:  # fmt: skip
    """ops.playoff_backtest's figures for the points odds: one category (``fpts``), one result a
    week, the web's draws one for one."""
    lg = simulate(cut, p, league) if lg is None else lg
    n_leagues, teams = lg.tot.shape
    regular = len(n_weeks) - int(p["playoffs.weeks"][league])
    spots = min(int(p["playoffs.teams"][league]), teams)
    sims = int(p["playoffs.simulations"])
    sched = playoffs.round_robin(teams, regular)
    played = min(regular, sum(1 for d in n_weeks if d + timedelta(days=7) <= cut.as_of))
    real = []
    for w in range(regular):
        a = [m[0] for m in sched[w]]
        b = [m[1] for m in sched[w]]
        real.append(beat(lg.points[w][:, a], lg.points[w][:, b]))  # [L, M]: 1, a tie 0.5
    left = sched[played:]
    shift, draws, jitter = playoffs.season_draws(
        sims, teams, 1, left, season_share > 0, playoffs.SEED
    )
    so_far = playoffs.tally_weeks(real[:played], sched[:played], teams, 1, "matchups")
    if not played:
        so_far = tuple(np.zeros((n_leagues, teams)) for _ in range(3))  # type: ignore[assignment]
    odds = np.zeros((n_leagues, teams))
    for lgi in range(n_leagues):
        # pointsPlayoffOdds: one category, its spread a share of the league's average team
        spread = np.array([spread_share * lg.tot[lgi].mean()])
        ch = playoffs.chances(lg.tot[lgi][:, None], spread, left, shift, season_share)
        won = [(d < c).sum(-1).astype(float) for d, c in zip(draws, ch, strict=True)]
        sw, sl, st = playoffs.tally_weeks(won, left, teams, 1, "matchups")
        w, lo, ti = (x + s[lgi] for x, s in zip((sw, sl, st), so_far, strict=True))
        odds[lgi] = playoffs.made_cut(w, lo, ti, jitter, spots).mean(0)
    weekly = [
        playoffs.tally_weeks([real[w]], [sched[w]], teams, 1, "matchups")
        for w in range(played, regular)
    ]
    stack = tuple(
        np.stack([x[k] for x in weekly]) if weekly else np.zeros((0, n_leagues, teams))
        for k in range(3)
    )
    return pb.Figures(
        odds=odds,
        naive=pb.realized_made(*so_far, spots),
        coin=spots / teams,
        so_far=(so_far[0], so_far[1], so_far[2]),
        weekly=(stack[0], stack[1], stack[2]),
        spots=spots,
    )


# ---- the fit ---------------------------------------------------------------------------------


def _log_loss(odds: np.ndarray, made: np.ndarray, sims: int) -> float:
    q = pb._clip(odds, sims)
    return float(-(made * np.log(q) + (1 - made) * np.log(1 - q)).mean())


def fit(seasons: list[Season], p: dict[str, Any]) -> dict[str, Any]:
    """The declared rules on the tuning seasons: the spread measured, then the lasting share
    searched, with the slope at share 0 checked first."""
    league = seasons[0].league
    for s in seasons:
        if s.league != league or s.season not in TUNING[league]:
            msg = (
                f"{s.league} {s.season} is not a tuning season ({sorted(TUNING[league])});"
                " the fit reads only those"
            )
            raise SystemExit(msg)
    sims = int(p["playoffs.simulations"])
    built = [(s, cut, simulate(cut, p, league)) for s in seasons for cut in s.cuts]
    per_cut = [float(np.nanmean(spread_terms(lg, from_cut(s, cut)))) for s, cut, lg in built]
    share = math.sqrt(float(np.mean(per_cut)))
    spread_share = round(share, 3)
    prior = float(p["playoffs.points_spread_share"][league])
    grid: dict[float, float] = {}
    check = []
    for lasting in SHARES:
        losses = []
        for s, cut, lg in built:
            f = checkpoint(cut, s.weeks, p, league, spread_share, lasting, lg)
            made = f.made()
            losses.append(_log_loss(f.odds, made, sims))
            if lasting == 0:
                x = _logit(pb._clip(f.odds, sims)).ravel()
                check.append(
                    {
                        "season": s.season,
                        "as_of": cut.as_of.isoformat(),
                        "slope": logistic_slope(x, made.ravel()),
                        "log_loss": losses[-1],
                    }
                )
        grid[lasting] = float(np.mean(losses))
        print(f"points season share {lasting}: mean log loss {grid[lasting]:.5f}", flush=True)
    pick = min(SHARES, key=lambda k: (round(grid[k], 12), k))
    return {
        "league": league,
        "seasons": sorted(s.season for s in seasons),
        "points_spread_share": spread_share,
        "spread_by_checkpoint": [
            {"season": s.season, "as_of": cut.as_of.isoformat(), "share": math.sqrt(v)}
            for (s, cut, _), v in zip(built, per_cut, strict=True)
        ],
        "z_sd_at_prior": share / prior,
        "points_season_share": pick,
        "on_grid_edge": pick in (SHARES[0], SHARES[-1]),
        "log_loss": {"at_0": grid[0.0], "at_pick": grid[pick]},
        "grid": {str(k): v for k, v in grid.items()},
        "independent_check": check,
    }


# ---- judging ---------------------------------------------------------------------------------


def weekly_figures(
    lg: League, weeks: np.ndarray, spread_share: float, draws: np.ndarray
) -> dict[str, Any]:
    """Reported, not gated: the weekly z-scores' standard deviation and the weekly matchup chance's
    Brier gap over the coin, every pair, with resamples of the weeks."""
    sq = spread_terms(lg, weeks)  # [W, L, K]
    i, j = pairs(lg.tot.shape[1])
    gap = (lg.tot[:, i] - lg.tot[:, j]) / (spread_share * lg.tot.mean(-1, keepdims=True))
    ch = standings.normal_cdf(gap)  # [L, K]
    pts = lg.points[weeks]
    o = beat(pts[..., i], pts[..., j])  # [W, L, K]
    per_week_sq = np.nanmean(sq, axis=(1, 2))
    gain = ((0.5 - o) ** 2 - (ch - o) ** 2).mean(axis=(1, 2))  # [W]

    def z(c: np.ndarray) -> float:
        return math.sqrt(float((c * per_week_sq).sum() / c.sum())) / spread_share

    def g(c: np.ndarray) -> float:
        return float((c * gain).sum() / c.sum())

    ok = [c for c in draws if c.sum() > 0]
    one = np.ones(weeks.size)
    return {
        "z_sd": _interval(z(one), np.array([z(c) for c in ok])),
        "chance_vs_coin": _interval(g(one), np.array([g(c) for c in ok])),
    }


def judge(season: Season, p: dict[str, Any], *, seed: int = 0) -> dict[str, Any]:
    league = season.league
    spread_share = float(p["playoffs.points_spread_share"][league])
    lasting = float(p["playoffs.points_season_share"][league])
    sims = int(p["playoffs.simulations"])
    rng = np.random.default_rng(seed)
    cps = []
    for cut in season.cuts:
        lg = simulate(cut, p, league)
        f = checkpoint(cut, season.weeks, p, league, spread_share, lasting, lg)
        remaining = f.weekly[0].shape[0]
        draws = rng.multinomial(
            remaining, np.full(remaining, 1 / max(remaining, 1)), size=int(p["backtest.bootstrap"])
        ).astype(float)
        weeks = from_cut(season, cut)
        week_draws = rng.multinomial(
            weeks.size, np.full(weeks.size, 1 / weeks.size), size=int(p["backtest.bootstrap"])
        ).astype(float)
        cps.append(
            {
                "as_of": cut.as_of.isoformat(),
                "weeks_left": remaining,
                "points": pb.judge_figures(f, draws, sims),
                "weekly": weekly_figures(lg, weeks, spread_share, week_draws),
            }
        )
    return {
        "league": league,
        "season": season.season,
        "points_spread_share": spread_share,
        "points_season_share": lasting,
        "checkpoints": cps,
    }


def verdict(result: dict[str, Any]) -> list[str]:
    """The pass bar declared on #891 (#872's, one tally): what fails, empty when all passes."""
    fails = []
    for i, cp in enumerate(result["checkpoints"]):
        r = cp["points"]
        where = cp["as_of"]
        if not r["brier_vs_coin"][1] > 0:
            fails.append(f"{where}: the odds do not beat the coin {r['brier_vs_coin']}")
        if i > 0 and not r["brier_vs_naive"][1] > 0:
            fails.append(f"{where}: the odds do not beat the naive manager {r['brier_vs_naive']}")
        if not SLOPE[0] <= r["slope"][0] <= SLOPE[1]:
            fails.append(f"{where}: calibration slope {r['slope'][0]:.3f} outside {SLOPE}")
    return fails


# ---- the command line ------------------------------------------------------------------------


def _iv(v: list[float], f: str = "+.4f") -> str:
    return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"


def _line(cp: dict[str, Any]) -> str:
    r = cp["points"]
    b = r["brier"]
    w = cp["weekly"]
    return (
        f"{cp['as_of']} points ({cp['weeks_left']} weeks left): Brier model {b['model']:.4f},"
        f" naive {b['naive']:.4f}, coin {b['coin']:.4f}; vs coin {_iv(r['brier_vs_coin'])},"
        f" vs naive {_iv(r['brier_vs_naive'])}; slope {_iv(r['slope'], '.3f')};"
        f" weekly z sd {_iv(w['z_sd'], '.3f')}, weekly chance vs coin"
        f" {_iv(w['chance_vs_coin'])}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge", help="judge one season's checkpoints against the bar")
    j.add_argument("folder", type=Path)
    j.add_argument("--out", type=Path)
    j.add_argument("--judge-locked", action="store_true", help="the held-out season, once")
    f = sub.add_parser("fit", help="measure the spread and fit the lasting share on tuning")
    f.add_argument("folders", type=Path, nargs="+")
    f.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = standings.registry()
    if args.cmd == "fit":
        res = fit([pb.load(d) for d in args.folders], p)
        print(json.dumps(res, indent=2))
        if args.out:
            args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
        return 0
    season = pb.load(args.folder)
    if LOCKED.get(season.league) == season.season and not args.judge_locked:
        print(f"{season.league} {season.season} is held out (#751)", file=sys.stderr)
        return 2
    res = judge(season, p)
    for cp in res["checkpoints"]:
        print(_line(cp))
    fails = verdict(res)
    judged = season.season in JUDGED.get(season.league, set())
    res["verdict"] = {"pass": not fails, "fails": fails, "judged_season": judged}
    if not judged:
        print("(not a judged season: the bar is reported, not applied)")
    print(
        "PASS: every condition of the bar holds" if not fails else "FAIL:\n  " + "\n  ".join(fails)
    )
    if args.out:
        args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
