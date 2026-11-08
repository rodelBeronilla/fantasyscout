"""Walk-forward backtest of the playoff odds (#872, web/src/lib/playoff-odds.ts): the standings
model played forward over a schedule, judged against who made the cut on simulated leagues of real
seasons.

    uv run python -m ops.walk_forward --league nba --season 2023-24 --standings-out standings/
    uv run python -m ops.playoff_backtest judge standings/ --out playoffs.json
    uv run python -m ops.playoff_backtest fit tuning-2020-21/ tuning-2021-22/ tuning-2022-23/

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
play. The pass bar was declared on #872 before any run; ``verdict`` applies it. ``fit`` reads the
tuning seasons only.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import playoffs, standings, standings_backtest
from ops.standings import CATS
from ops.standings_backtest import JUDGED, STATS, TUNING, Cut, beat, cat_values, logistic_slope
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


def checkpoint(
    cut: Cut, n_weeks: list[Any], p: dict[str, Any], league: str, share: float
) -> dict[str, Figures]:
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
    shift, draws, jitter = playoffs.season_draws(sims, teams, n, left, share > 0, playoffs.SEED)
    spread = standings.spreads(league, CATS, lg.n, "h2h", p=p)  # [L, 9]
    won: list[list[np.ndarray]] = []
    for lgi in range(n_leagues):
        ch = playoffs.chances(lg.tot[lgi], spread[lgi], left, shift, share)
        won.append([(d < c).sum(-1).astype(float) for d, c in zip(draws, ch, strict=True)])
    out = {}
    for tally in TALLIES:
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
    share = float(p["playoffs.season_share"][league])
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


# ---- the fit ---------------------------------------------------------------------------------


def _log_loss(odds: np.ndarray, made: np.ndarray, sims: int) -> float:
    q = _clip(odds, sims)
    return float(-(made * np.log(q) + (1 - made) * np.log(1 - q)).mean())


def fit(seasons: list[standings_backtest.Season], p: dict[str, Any]) -> dict[str, Any]:
    """The declared rule: the season share with the lowest mean log loss of the odds over the
    tuning checkpoints, both tallies weighted equally (ties smaller). Today's odds (a share of 0)
    are checked first: their calibration slope at each tuning checkpoint."""
    league = seasons[0].league
    for s in seasons:
        if s.league != league or s.season not in TUNING[league]:
            msg = (
                f"{s.league} {s.season} is not a tuning season ({sorted(TUNING[league])});"
                " the fit reads only those"
            )
            raise SystemExit(msg)
    sims = int(p["playoffs.simulations"])
    grid: dict[float, float] = {}
    check: list[dict[str, Any]] = []
    for share in SHARES:
        losses = []
        for s in seasons:
            for cut in s.cuts:
                figs = checkpoint(cut, s.weeks, p, league, share)
                for tally, f in figs.items():
                    made = f.made()
                    losses.append(_log_loss(f.odds, made, sims))
                    if share == 0:
                        x = standings_backtest._logit(_clip(f.odds, sims)).ravel()
                        check.append(
                            {
                                "season": s.season,
                                "as_of": cut.as_of.isoformat(),
                                "tally": tally,
                                "slope": logistic_slope(x, made.ravel()),
                                "log_loss": losses[-1],
                            }
                        )
        grid[share] = float(np.mean(losses))
        print(f"season share {share}: mean log loss {grid[share]:.5f}", flush=True)
    pick = min(SHARES, key=lambda k: (round(grid[k], 12), k))
    return {
        "league": league,
        "seasons": sorted(s.season for s in seasons),
        "season_share": pick,
        "log_loss": {"at_0": grid[0.0], "at_pick": grid[pick]},
        "grid": {str(k): v for k, v in grid.items()},
        "independent_check": check,
    }


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
    f = sub.add_parser("fit", help="fit playoffs.season_share on the tuning seasons")
    f.add_argument("folders", type=Path, nargs="+")
    f.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = standings.registry()
    if args.cmd == "fit":
        res = fit([load(d) for d in args.folders], p)
        print(json.dumps(res, indent=2))
        if args.out:
            args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
        return 0
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
