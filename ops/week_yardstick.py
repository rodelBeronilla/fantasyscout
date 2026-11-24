"""S0 (#1077): the yardstick for a player's week, by category.

    uv run python -m ops.week_yardstick judge closeness-nba-2020-21/ ... --out s0.json

How well the current projection, turned into a week, predicts each of the nine categories of a
player's week, against the naive manager. It reads the weekly exports of ops.closeness_backtest
(every Monday of a season, a point-in-time build as of that morning, ADR 0018): the board's players
with their projected per-game line, their season-so-far per-game line, their team's games that week
and their injury listing, and each player's real week from gold.fct_player_week.

Declared on #1077 before the run:
- the tuning seasons only, each league reported on its own;
- the population each Monday: the top ``POOL`` on the board by value (8 teams x 13 spots, and the
  next 26 as the waiver pool) among the players with a game scheduled that week;
- projection-week: the projected per-game line x the week's games, a player listed out or doubtful
  counting for none (as the matchup card does);
- naive-week: the season-so-far per-game line x the week's scheduled games, ignoring the listing;
- the error per category of the week total; FG% and FT% as the error in makes at the real attempts,
  so a percentage weighs by volume;
- the noise: a paired bootstrap over weeks, players resampled within each week, ``RESAMPLES``
  resamples at seed 0; seeds 0 to 19 re-drawn as a check.
A later study passes in a category only if it lowers that category's RMSE by at least a quarter of
the noise recorded here (the bootstrap SD of the projection's RMSE), with the 95% interval below
zero, and no category gets worse by more than its noise.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from ops.closeness_backtest import LISTED_OUT, NAIVE
from ops.matchup import LINE
from ops.standings import CATS
from ops.standings_backtest import JUDGED, STATS, TUNING
from ops.walk_forward import LOCKED

# def: the owner's league, 8 teams x 13 spots, and the next 26 as the waiver pool (#1077)
POOL = 8 * 13 + 26
# def: the bootstrap's resamples and seeds, as ADR 0030 recorded them
RESAMPLES = 1000
SEEDS = 20
# the nine categories, in the order the report prints them: the seven counts, then FG% and FT%
CATEGORIES = ("PTS", "REB", "AST", "STL", "BLK", "3PM", "TO", "FG%", "FT%")


@dataclass(frozen=True)
class Week:
    """One Monday's population: predicted and real week, per category, for each player."""

    as_of: date
    proj: np.ndarray  # [P, 9] projection-week, in the units the error is taken in
    naive: np.ndarray  # [P, 9] naive-week
    real: np.ndarray  # [P, 9] the real week


def category_weeks(per_game: np.ndarray, games: np.ndarray, real: np.ndarray) -> np.ndarray:
    """A week's nine category predictions from a per-game line in ``STATS`` order (seven counts,
    then fgm, fga, ftm, fta) and the games counted. The seven counts are per game x games; FG% and
    FT% are the predicted rate at the real attempts (makes), so the error is in makes."""
    counts = per_game[:, :7] * games[:, None]
    fg_rate = np.divide(
        per_game[:, 7], per_game[:, 8], out=np.zeros(len(per_game)), where=per_game[:, 8] > 0
    )
    ft_rate = np.divide(
        per_game[:, 9], per_game[:, 10], out=np.zeros(len(per_game)), where=per_game[:, 10] > 0
    )
    fg = fg_rate * real[:, 8]
    ft = ft_rate * real[:, 10]
    return np.column_stack([counts, fg, ft])


def real_weeks(real: np.ndarray) -> np.ndarray:
    """The real week in the same nine columns: the seven counts, then makes (FG, FT)."""
    return np.column_stack([real[:, :7], real[:, 7], real[:, 9]])


def flat_placebo(
    counted: list[np.ndarray], study: list[np.ndarray]
) -> tuple[float, list[np.ndarray]]:
    """The placebo for a study that changes the games count (#1088).

    The historical boards carry the injury listing on almost no player-week, so the
    projection-week counts every scheduled game and any discount on games looks like a gain. The
    placebo takes the same total discount the study takes over all its weeks and spreads it over
    every game counted: each player's counted games times one share. ``counted`` is each week's
    games as the projection-week counts them, ``study`` the study's; returns the share taken off
    and each week's placebo games."""
    total = float(sum(c.sum() for c in counted))
    share = 1.0 - float(sum(s.sum() for s in study)) / total if total else 0.0
    return share, [c * (1.0 - share) for c in counted]


def population(value: np.ndarray, scheduled: np.ndarray, pool: int = POOL) -> np.ndarray:
    """The indexes of the players who matter that Monday: the top ``pool`` by board value among the
    players with a game scheduled."""
    eligible = np.flatnonzero(scheduled > 0)
    order = eligible[np.argsort(-value[eligible], kind="stable")]
    return order[:pool]


def load(folder: Path) -> tuple[str, str, list[Week]]:
    """A season's weeks from a weekly export folder (ops.closeness_backtest export)."""
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    weeks_df = pd.read_csv(folder / "weeks.csv", parse_dates=["week"], dtype={"player_id": str})
    weeks_df["week"] = weeks_df["week"].dt.date
    out = []
    for text in meta["weeks"]:
        as_of = date.fromisoformat(text)
        monday = as_of - timedelta(days=as_of.weekday())
        df = pd.read_csv(folder / f"players-{text}.csv", dtype={"player_id": str})
        ids = {pid: i for i, pid in enumerate(df["player_id"])}
        x = np.zeros((len(df), len(STATS)))
        rows = weeks_df[(weeks_df["week"] == monday) & weeks_df["player_id"].isin(ids.keys())]
        for r in rows.itertuples(index=False):
            x[ids[r.player_id]] = [getattr(r, s) for s in STATS]
        scheduled = df["games_this_week"].astype(float).fillna(0).to_numpy()
        listed = df["injury_group"].isin(LISTED_OUT).to_numpy()
        value = df[list(CATS)].astype(float).fillna(0).to_numpy().sum(axis=1)
        keep = population(value, scheduled)
        proj_line = df[list(LINE)].astype(float).fillna(0).to_numpy()[keep]
        naive_line = df[list(NAIVE)].astype(float).fillna(0).to_numpy()[keep]
        real = x[keep]
        card_games = np.where(listed[keep], 0.0, scheduled[keep])
        out.append(
            Week(
                as_of=as_of,
                proj=category_weeks(proj_line, card_games, real),
                naive=category_weeks(naive_line, scheduled[keep], real),
                real=real_weeks(real),
            )
        )
    return meta["league"], meta["season"], out


@dataclass
class Category:
    category: str
    rmse_projection: float
    rmse_naive: float
    mae_projection: float
    mae_naive: float
    diff: float  # projection - naive, RMSE
    diff_low: float
    diff_high: float
    noise: float  # bootstrap SD of the projection's RMSE: the harness's noise
    bar: float  # a quarter of the noise: what a study must lower the RMSE by
    seed_noise_min: float
    seed_noise_max: float


def _rmse(err: np.ndarray) -> np.ndarray:
    return np.sqrt(np.mean(err**2, axis=0))


def _resample(weeks: list[Week], rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """One paired resample: weeks with replacement, players with replacement within each week;
    the projection's and the naive manager's errors over the same rows."""
    pick = rng.integers(0, len(weeks), len(weeks))
    ep, en = [], []
    for i in pick:
        w = weeks[i]
        rows = rng.integers(0, len(w.real), len(w.real))
        ep.append(w.proj[rows] - w.real[rows])
        en.append(w.naive[rows] - w.real[rows])
    return np.concatenate(ep), np.concatenate(en)


def judge(weeks: list[Week], resamples: int = RESAMPLES, seeds: int = SEEDS) -> list[Category]:
    """Per category: the pooled errors, the paired bootstrap interval of projection - naive, and
    the noise (the bootstrap SD of the projection's RMSE) with its range over ``seeds`` seeds."""
    ep = np.concatenate([w.proj - w.real for w in weeks])
    en = np.concatenate([w.naive - w.real for w in weeks])
    rp, rn = _rmse(ep), _rmse(en)
    mp, mn = np.mean(np.abs(ep), axis=0), np.mean(np.abs(en), axis=0)
    noise_by_seed = []
    diffs0 = None
    for seed in range(seeds):
        rng = np.random.default_rng(seed)
        boot_p, boot_d = [], []
        for _ in range(resamples):
            bp, bn = _resample(weeks, rng)
            boot_p.append(_rmse(bp))
            boot_d.append(_rmse(bp) - _rmse(bn))
        noise_by_seed.append(np.std(np.array(boot_p), axis=0, ddof=1))
        if seed == 0:
            diffs0 = np.array(boot_d)
    assert diffs0 is not None
    noise = noise_by_seed[0]
    spread = np.array(noise_by_seed)
    lo, hi = np.percentile(diffs0, [2.5, 97.5], axis=0)
    return [
        Category(
            category=c,
            rmse_projection=float(rp[k]),
            rmse_naive=float(rn[k]),
            mae_projection=float(mp[k]),
            mae_naive=float(mn[k]),
            diff=float(rp[k] - rn[k]),
            diff_low=float(lo[k]),
            diff_high=float(hi[k]),
            noise=float(noise[k]),
            bar=float(noise[k] / 4),
            seed_noise_min=float(spread[:, k].min()),
            seed_noise_max=float(spread[:, k].max()),
        )
        for k, c in enumerate(CATEGORIES)
    ]


def table(league: str, seasons: list[str], weeks: int, players: int, cats: list[Category]) -> str:
    span = ", ".join(seasons)
    head = f"### {league.upper()}, tuning seasons {span}: {weeks} weeks, {players} player-weeks\n\n"
    rows = [
        "| Category | RMSE projection | RMSE naive | Projection - naive (95%) "
        "| MAE projection | MAE naive | Noise (SD) | Bar (a quarter) |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for c in cats:
        rows.append(
            f"| {c.category} | {c.rmse_projection:.3f} | {c.rmse_naive:.3f} "
            f"| {c.diff:+.3f} ({c.diff_low:+.3f} to {c.diff_high:+.3f}) "
            f"| {c.mae_projection:.3f} | {c.mae_naive:.3f} "
            f"| {c.noise:.4f} ({c.seed_noise_min:.4f} to {c.seed_noise_max:.4f}) | {c.bar:.4f} |"
        )
    return head + "\n".join(rows) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.week_yardstick")
    sub = parser.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser(
        "judge", help="the yardstick from weekly export folders, one league at a time"
    )
    j.add_argument("folders", nargs="+", type=Path)
    j.add_argument("--out", type=Path, required=True)
    j.add_argument("--resamples", type=int, default=RESAMPLES)
    j.add_argument("--seeds", type=int, default=SEEDS)
    args = parser.parse_args(argv)
    by_league: dict[str, tuple[list[str], list[Week]]] = {}
    for folder in args.folders:
        league, season, weeks = load(folder)
        if season in JUDGED[league] or season == LOCKED[league] or season not in TUNING[league]:
            print(
                f"{league} {season} is not a tuning season: S0 reads those only (#1077)",
                file=sys.stderr,
            )
            return 2
        seasons, all_weeks = by_league.setdefault(league, ([], []))
        seasons.append(season)
        all_weeks.extend(weeks)
    report: dict[str, object] = {}
    text = []
    for league, (seasons, weeks) in sorted(by_league.items()):
        cats = judge(weeks, args.resamples, args.seeds)
        players = sum(len(w.real) for w in weeks)
        report[league] = {
            "seasons": sorted(seasons),
            "weeks": len(weeks),
            "player_weeks": players,
            "categories": [asdict(c) for c in cats],
        }
        text.append(table(league, sorted(seasons), len(weeks), players, cats))
    args.out.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print("\n".join(text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
