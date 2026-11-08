"""Walk-forward backtest of the playoff odds (#872, web/src/lib/playoff-odds.ts): the standings
model played forward over a schedule, judged against who made the cut on simulated leagues of real
seasons.

    uv run python -m ops.walk_forward --league nba --season 2023-24 --standings-out standings/
    uv run python -m ops.playoff_backtest judge standings/ --out playoffs.json
    uv run python -m ops.playoff_cv cv nba-2020-21/ nba-2021-22/ nba-2022-23/ --out cv.json

It reads the inputs ops.standings_backtest reads (ADR 0021) and drafts the same leagues at each
checkpoint. Each league gets:

- **a schedule:** the web's round robin over the regular season's fantasy weeks, the season's
  weeks less the last ``playoffs.weeks``;
- **a record so far:** the weeks that ended before the checkpoint, played on real box scores by
  the drafted rosters (level at the first game day);
- **a cut:** the top ``playoffs.teams`` by winning share, then wins.

The odds come from ops.playoffs, the web's simulation draw for draw. What happened is the rest of
the regular season played on real box scores, a tie for the last place sharing the places left.
Both tallies, categories and matchups, are judged: the Brier score against a coin (the base rate)
and the naive manager (the current standings order), and the calibration slope (outcome on
logit(odds)). Intervals are 95%, from ``backtest.bootstrap`` resamples of the weeks still to
play. The pass bar was declared on #872 before any run; ``verdict`` applies it. The fits, and the
folds within the tuning seasons that judge a lasting share per tally (#900), are ops.playoff_cv's.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import playoffs, standings, standings_backtest
from ops.standings import CATS
from ops.standings_backtest import JUDGED, STATS, Cut, beat, cat_values, logistic_slope
from ops.walk_forward import LOCKED

TALLIES = ("categories", "matchups")
# declared on #872 before any run
SHARES = tuple(round(0.1 * i, 1) for i in range(9))
SLOPE = (0.8, 1.25)
SLOPE_EVERY = 10


# ---- loading ---------------------------------------------------------------------------------


def load(folder: Path) -> standings_backtest.Season:
    """ops.standings_backtest's season, each checkpoint holding every week of the season (the
    weeks before it give the record so far)."""
    season = standings_backtest.load(folder)
    weeks_df = pd.read_csv(folder / "weeks.csv", parse_dates=["week"], dtype={"player_id": str})
    index = {d: i for i, d in enumerate(season.weeks)}
    cuts = []
    for cut in season.cuts:
        ids = pd.read_csv(folder / f"players-{cut.as_of.isoformat()}.csv", dtype={"player_id": str})
        pos = {pid: i for i, pid in enumerate(ids["player_id"])}
        x = np.zeros((len(season.weeks), len(pos), len(STATS)))
        for r in weeks_df[weeks_df["player_id"].isin(pos.keys())].itertuples(index=False):
            x[index[r.week.date()], pos[r.player_id]] = [getattr(r, s) for s in STATS]
        cuts.append(dataclasses.replace(cut, x=x, weeks=np.arange(len(season.weeks))))
    return dataclasses.replace(season, cuts=cuts)


# ---- one checkpoint --------------------------------------------------------------------------


def realized_made(w: np.ndarray, lo: np.ndarray, ti: np.ndarray, spots: int) -> np.ndarray:
    """Each team's place in the cut [..., T]: 1 inside, 0 out, and teams level on winning share
    and wins across the cut sharing the places left."""
    sh = playoffs.share(w, lo, ti)
    a_sh, b_sh = sh[..., :, None], sh[..., None, :]
    a_w, b_w = w[..., :, None], w[..., None, :]
    level_share = np.isclose(b_sh, a_sh, rtol=0, atol=1e-12)
    level = level_share & np.isclose(b_w, a_w, rtol=0, atol=1e-12)
    better = ((b_sh > a_sh) & ~level_share) | (level_share & (b_w > a_w) & ~level)
    out: np.ndarray = np.clip((spots - better.sum(-1)) / level.sum(-1), 0, 1)
    return out


@dataclass
class Figures:
    """One checkpoint, one tally: the odds, the naive and coin forecasts, and what happened, with
    each remaining week's tally kept so a resample of the weeks re-tallies the final records."""

    odds: np.ndarray  # [L, T]
    naive: np.ndarray  # [L, T]
    coin: float
    so_far: tuple[np.ndarray, np.ndarray, np.ndarray]  # wins, losses, ties [L, T]
    weekly: tuple[np.ndarray, np.ndarray, np.ndarray]  # [Wr, L, T]
    spots: int

    def made(self, c: np.ndarray | None = None) -> np.ndarray:
        """What happened with the remaining weeks weighted by ``c`` [Wr] (each once by default)."""
        k = np.ones(self.weekly[0].shape[0]) if c is None else c
        w, lo, ti = (
            s + np.tensordot(k, x, axes=(0, 0))
            for s, x in zip(self.so_far, self.weekly, strict=True)
        )
        return realized_made(w, lo, ti, self.spots)


def shares_of(share: float | Mapping[str, float]) -> dict[str, float]:
    """Each tally's lasting share: one number for both, or one per tally (#900)."""
    if isinstance(share, Mapping):
        return {t: float(share[t]) for t in TALLIES}
    return dict.fromkeys(TALLIES, float(share))


def checkpoint(
    cut: Cut,
    n_weeks: list[Any],
    p: dict[str, Any],
    league: str,
    share: float | Mapping[str, float],
    scale: float | None = None,
) -> dict[str, Figures]:
    """Both tallies' figures at one checkpoint, each tally's odds at its own lasting share;
    ``scale`` overrides the registry's ``standings.spread_scale`` (the folds' refits, #900)."""
    by_tally = shares_of(share)
    lg = standings_backtest.simulate(cut, p, league, standings_backtest._seed(cut.as_of))
    n_leagues, teams = lg.tot.shape[:2]
    n = len(CATS)
    regular = len(n_weeks) - int(p["playoffs.weeks"][league])
    spots = min(int(p["playoffs.teams"][league]), teams)
    sims = int(p["playoffs.simulations"])
    sched = playoffs.round_robin(teams, regular)
    played = min(regular, sum(1 for d in n_weeks if d + timedelta(days=7) <= cut.as_of))
    # what happened: categories won by the first side of each matchup, every regular week
    real = []
    for w in range(regular):
        cv = cat_values(lg.xt[w])
        a = [m[0] for m in sched[w]]
        b = [m[1] for m in sched[w]]
        real.append(beat(cv[:, a], cv[:, b]).sum(-1))  # [L, M]
    left = sched[played:]
    spread = standings.spreads(league, CATS, lg.n, "h2h", p=p, scale=scale)  # [L, 9]
    # the web's draws at each share a tally reads: the shift is drawn only above 0
    won_at: dict[float, tuple[list[list[np.ndarray]], np.ndarray]] = {}
    for at in sorted(set(by_tally.values())):
        shift, draws, jitter = playoffs.season_draws(sims, teams, n, left, at > 0, playoffs.SEED)
        won_at[at] = (
            [
                [
                    (d < c).sum(-1).astype(float)
                    for d, c in zip(
                        draws,
                        playoffs.chances(lg.tot[lgi], spread[lgi], left, shift, at),
                        strict=True,
                    )
                ]
                for lgi in range(n_leagues)
            ],
            jitter,
        )
    out = {}
    for tally in TALLIES:
        won, jitter = won_at[by_tally[tally]]
        so_far = playoffs.tally_weeks(real[:played], sched[:played], teams, n, tally)
        if not played:
            so_far = tuple(np.zeros((n_leagues, teams)) for _ in range(3))  # type: ignore[assignment]
        weekly = [
            playoffs.tally_weeks([real[w]], [sched[w]], teams, n, tally)
            for w in range(played, regular)
        ]
        stack = tuple(
            np.stack([x[k] for x in weekly]) if weekly else np.zeros((0, n_leagues, teams))
            for k in range(3)
        )
        odds = np.zeros((n_leagues, teams))
        for lgi in range(n_leagues):
            sw, sl, st = playoffs.tally_weeks(won[lgi], left, teams, n, tally)
            start = [np.broadcast_to(x[lgi], jitter.shape) for x in so_far]
            made = playoffs.made_cut(sw + start[0], sl + start[1], st + start[2], jitter, spots)
            odds[lgi] = made.mean(0)
        out[tally] = Figures(
            odds=odds,
            naive=realized_made(*so_far, spots),
            coin=spots / teams,
            so_far=(so_far[0], so_far[1], so_far[2]),
            weekly=(stack[0], stack[1], stack[2]),
            spots=spots,
        )
    return out


# ---- judging ---------------------------------------------------------------------------------


def _clip(odds: np.ndarray, sims: int) -> np.ndarray:
    half = 1 / (2 * sims)
    out: np.ndarray = np.clip(odds, half, 1 - half)
    return out


def _brier(f: Figures, made: np.ndarray) -> dict[str, float]:
    return {
        "model": float(((f.odds - made) ** 2).mean()),
        "naive": float(((f.naive - made) ** 2).mean()),
        "coin": float(((f.coin - made) ** 2).mean()),
    }


def judge_figures(f: Figures, draws: np.ndarray, sims: int) -> dict[str, Any]:
    made = f.made()
    b = _brier(f, made)
    boots = [_brier(f, f.made(c)) for c in draws]
    x = standings_backtest._logit(_clip(f.odds, sims)).ravel()
    out: dict[str, Any] = {"brier": b, "made_share": float(made.mean())}
    for base in ("coin", "naive"):
        out[f"brier_vs_{base}"] = standings_backtest._interval(
            b[base] - b["model"], np.array([d[base] - d["model"] for d in boots])
        )
    out["slope"] = standings_backtest._interval(
        logistic_slope(x, made.ravel()),
        np.array([logistic_slope(x, f.made(c).ravel()) for c in draws[::SLOPE_EVERY]]),
    )
    return out


def judge(season: standings_backtest.Season, p: dict[str, Any], *, seed: int = 0) -> dict[str, Any]:
    league = season.league
    share = shares_of(p["playoffs.season_share"][league])
    sims = int(p["playoffs.simulations"])
    rng = np.random.default_rng(seed)
    cps = []
    for cut in season.cuts:
        figs = checkpoint(cut, season.weeks, p, league, share)
        remaining = figs[TALLIES[0]].weekly[0].shape[0]
        draws = rng.multinomial(
            remaining, np.full(remaining, 1 / max(remaining, 1)), size=int(p["backtest.bootstrap"])
        ).astype(float)
        res: dict[str, Any] = {"as_of": cut.as_of.isoformat(), "weeks_left": remaining}
        for tally, f in figs.items():
            res[tally] = judge_figures(f, draws, sims)
        cps.append(res)
    return {"league": league, "season": season.season, "season_share": share, "checkpoints": cps}


def verdict(result: dict[str, Any]) -> list[str]:
    """The pass bar declared on #872: what fails, empty when everything passes."""
    fails = []
    for i, cp in enumerate(result["checkpoints"]):
        for tally in TALLIES:
            r = cp[tally]
            where = f"{tally} {cp['as_of']}"
            if not r["brier_vs_coin"][1] > 0:
                fails.append(f"{where}: the odds do not beat the coin {r['brier_vs_coin']}")
            if i > 0 and not r["brier_vs_naive"][1] > 0:
                fails.append(
                    f"{where}: the odds do not beat the naive manager {r['brier_vs_naive']}"
                )
            if not SLOPE[0] <= r["slope"][0] <= SLOPE[1]:
                fails.append(f"{where}: calibration slope {r['slope'][0]:.3f} outside {SLOPE}")
    return fails


def log_loss(odds: np.ndarray, made: np.ndarray, sims: int) -> float:
    """The odds' mean log loss, clipped as the slope's logit is (the fits, ops.playoff_cv)."""
    q = _clip(odds, sims)
    return float(-(made * np.log(q) + (1 - made) * np.log(1 - q)).mean())


# ---- the command line ------------------------------------------------------------------------


def _line(cp: dict[str, Any], tally: str) -> str:
    r = cp[tally]

    def iv(v: list[float], f: str = "+.4f") -> str:
        return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"

    b = r["brier"]
    return (
        f"{cp['as_of']} {tally} ({cp['weeks_left']} weeks left): Brier model {b['model']:.4f},"
        f" naive {b['naive']:.4f}, coin {b['coin']:.4f}; vs coin {iv(r['brier_vs_coin'])},"
        f" vs naive {iv(r['brier_vs_naive'])}; slope {iv(r['slope'], '.3f')}"
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
    args = parser.parse_args(argv)
    p = standings.registry()
    season = standings_backtest.load(args.folder)
    if LOCKED.get(season.league) == season.season and not args.judge_locked:
        print(f"{season.league} {season.season} is held out (#751)", file=sys.stderr)
        return 2
    res = judge(load(args.folder), p)
    for cp in res["checkpoints"]:
        for tally in TALLIES:
            print(_line(cp, tally))
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
