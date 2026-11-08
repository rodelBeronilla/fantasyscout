"""Walk-forward backtest of the week's matchup card (#869): its category chances and the band it
calls too close, judged on simulated leagues of real seasons, one fantasy week at a time.

    uv run python -m ops.closeness_backtest export --league nba --season 2023-24 --out closeness/
    uv run python -m ops.closeness_backtest judge closeness/ --out closeness.json
    uv run python -m ops.closeness_backtest fit tuning-2020-21/ tuning-2021-22/ tuning-2022-23/

The leagues are #755's (ops.standings_backtest, ADR 0021), drafted afresh every week: at the first
game day and then every Monday of the regular season a point-in-time build (ADR 0018) gives the
board as it stood that morning, ``backtest.standings_leagues`` leagues are drafted from it, and
every pair of teams meets. The card projects each side's week as the web does (ops.matchup): each
player's projected per-game line times the team's games that week, a player listed out or
doubtful counting for none. What happened is that week's real regular-season box scores.

Judged, pooled over a season's weeks:

- **the card's chances:** the Brier score against a coin flip and the naive manager (the same card
  from each player's season so far per game, last season's line before they have played), and
  the calibration slope (outcome on logit(chance));
- **the band, by decision replay:** in each matchup the manager's team streams one free agent for
  the week, picked as the card's stream picks one (the best sum of last-ten category values over
  the categories the card does not call a win). The arms differ in what they call a win: the
  fitted band, today's 5% share rule, no band (only the categories projected lost) and the band on
  the naive manager's projection. The outcome is the categories won that week.

Intervals are 95%, from ``backtest.bootstrap`` resamples of the season's weeks. The pass bar was
declared on #869 before any run; ``verdict`` applies it. ``fit`` reads the tuning seasons only.
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
import tempfile
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

from ops import matchup as card
from ops import standings, standings_backtest, walk_forward
from ops.standings import CATS
from ops.standings_backtest import JUDGED, STATS, TUNING, beat, cat_values, draft, pairs
from ops.walk_forward import LOCKED

RECENT = tuple(f"recent_{c}" for c in CATS)
NAIVE = tuple(
    f"naive_{c}"
    for c in (
        "points_pg",
        "rebounds_total_pg",
        "assists_pg",
        "steals_pg",
        "blocks_pg",
        "three_pointers_made_pg",
        "turnovers_pg",
        "fgm_pg",
        "fga_pg",
        "ftm_pg",
        "fta_pg",
    )
)
LISTED_OUT = ("out", "doubtful")
# today's rule, the replay's Share arm: a margin within this share of the larger total is close
SHARE_RULE = 0.05
# declared on #869 before any run
SPREADS = tuple(round(0.01 * 1.025**i, 6) for i in range(374))
BANDS = tuple(round(0.025 * i, 3) for i in range(17))
SLOPE = (0.8, 1.25)
SLOPE_EVERY = 10
ARMS = ("band", "share", "losing", "naive")
BINS = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0001)


# ---- what a week's build hands over ---------------------------------------------------------


def week_days(first: date, last: date) -> list[date]:
    """The first game day, then every Monday of the regular season after it."""
    out = [first]
    monday = first - timedelta(days=first.weekday()) + timedelta(days=7)
    while monday <= last:
        out.append(monday)
        monday += timedelta(days=7)
    return out


def export_week(cut: Any, league: str, season: str, as_of: date, out: Path) -> None:
    """The board's players on a week's first day: category values (the draft's), last-ten values
    (the stream's), the projected and the naive per-game lines, games this week and the injury
    group. ``cut`` is that day's point-in-time build."""
    naive_cols = ", ".join(f"n.{c.removeprefix('naive_')} as {c}" for c in NAIVE)
    sql = f"""
        with board as (select * from gold.mart_board where league = $league),
        naive_line as (
            select * from gold.int_player_window_lines
            where league = $league and window_name = 'season' and season <= $season
            qualify row_number() over (partition by player_id order by season desc) = 1
        )
        select b.player_id, {", ".join(f"b.{c}" for c in (*CATS, *RECENT, *card.LINE))},
            b.games_this_week, b.injury_group, {naive_cols}
        from board as b
        left join naive_line as n on n.player_id = b.player_id
    """
    df = cut.execute(sql, {"league": league, "season": season}).fetchdf()
    df.to_csv(out / f"players-{as_of.isoformat()}.csv", index=False)


def export(full_db: Path, league: str, season: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(full_db), read_only=True) as full:
        first, last = walk_forward._season_span(full, league, season)
        standings_backtest.export_weeks(full, league, season, first, out)
    days = week_days(first, last)
    meta = {"league": league, "season": season, "weeks": [d.isoformat() for d in days]}
    (out / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        for as_of in days:
            db = Path(tmp) / f"week-{as_of.isoformat()}.duckdb"
            walk_forward._build(as_of, db)
            with duckdb.connect(str(db), read_only=True) as cut:
                export_week(cut, league, season, as_of, out)
            db.unlink()
            print(f"{as_of}: the board exported", flush=True)


# ---- loading ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Week:
    as_of: date
    z: np.ndarray  # [P, 9] category values above replacement: the draft's order
    recent: np.ndarray  # [P, 9] last-ten values, nan where none
    proj: np.ndarray  # [P, 11] projected per-game line
    naive: np.ndarray  # [P, 11] season so far per game
    games: np.ndarray  # [P] games counted this week (none when listed out or doubtful)
    x: np.ndarray  # [P, 11] the week's real box-score totals


@dataclass(frozen=True)
class Season:
    league: str
    season: str
    weeks: list[Week]


def _num(df: pd.DataFrame, cols: tuple[str, ...]) -> np.ndarray:
    out: np.ndarray = df[list(cols)].astype(float).fillna(0).to_numpy()
    return out


def load(folder: Path) -> Season:
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
        listed = df["injury_group"].isin(LISTED_OUT).to_numpy()
        games = np.where(listed, 0.0, df["games_this_week"].astype(float).fillna(0).to_numpy())
        out.append(
            Week(
                as_of=as_of,
                z=_num(df, CATS),
                recent=df[list(RECENT)].astype(float).to_numpy(),
                proj=_num(df, card.LINE),
                naive=_num(df, NAIVE),
                games=games,
                x=x,
            )
        )
    return Season(meta["league"], meta["season"], out)


# ---- one week's simulated leagues ------------------------------------------------------------


@dataclass
class Sim:
    """One week's leagues: each team's projected and real week, and the stream each target set
    picks."""

    proj: np.ndarray  # [L, T, 11]
    naive: np.ndarray  # [L, T, 11]
    g: np.ndarray  # [L, T] games counted
    xt: np.ndarray  # [L, T, 11] the real week
    best: np.ndarray  # [L, 512] the stream for each set of target categories (a bit mask); -1 none
    x: np.ndarray  # [P, 11]


MASKS = np.array([[(m >> c) & 1 for c in range(len(CATS))] for m in range(2 ** len(CATS))])


def simulate(w: Week, p: dict[str, Any], league: str, seed: int) -> Sim:
    teams = int(p["scale.teams"][league])
    spots = int(p["scale.roster_spots"][league])
    n_leagues = int(p["backtest.standings_leagues"])
    rng = np.random.default_rng(seed)
    rost = draft(
        rng, w.z.sum(1), n_leagues, teams, spots, int(p["backtest.standings_draft_choice"])
    )
    g = w.games[rost]
    # the stream's candidates: undrafted, with games this week and a last-ten line
    can = (w.games > 0) & np.isfinite(w.recent).any(1)
    recent = np.nan_to_num(w.recent, nan=0.0)
    fit = MASKS @ recent.T  # [512, P]
    best = np.full((n_leagues, len(MASKS)), -1, dtype=int)
    for lg in range(n_leagues):
        free = can.copy()
        free[rost[lg].ravel()] = False
        idx = np.flatnonzero(free)
        if len(idx):
            best[lg] = idx[np.argmax(fit[:, idx], axis=1)]
    best[:, 0] = -1  # no target, no stream
    return Sim(
        proj=(w.proj[rost] * g[..., None]).sum(2),
        naive=(w.naive[rost] * g[..., None]).sum(2),
        g=g.sum(2),
        xt=w.x[rost].sum(2),
        best=best,
        x=w.x,
    )


def directed(teams: int) -> tuple[np.ndarray, np.ndarray]:
    i, j = np.nonzero(~np.eye(teams, dtype=bool))
    return i, j


def items(s: Sim, sigma: np.ndarray, *, naive: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Every pair of teams once: the first's chance per category and what happened [L, K, 9]."""
    i, j = pairs(s.xt.shape[1])
    tot = s.naive if naive else s.proj
    _, chance, _ = card.chances(tot[:, i], tot[:, j], s.g[:, i], s.g[:, j], sigma)
    cv = cat_values(s.xt)
    return chance, beat(cv[:, i], cv[:, j])


def unit_items(s: Sim) -> tuple[np.ndarray, np.ndarray]:
    """The margin over its spread at sigma = 1, per category, and what happened: the fit's input."""
    i, j = pairs(s.xt.shape[1])
    a, b, ga, gb = s.proj[:, i], s.proj[:, j], s.g[:, i], s.g[:, j]
    edge, _, _ = card.chances(a, b, ga, gb, np.ones(len(CATS)))
    unit = card.unit_spread(a, b, ga, gb)
    cv = cat_values(s.xt)
    t = np.where(unit > 0, edge / np.where(unit > 0, unit, 1), np.nan)
    return t, beat(cv[:, i], cv[:, j])


def _codes(targets: np.ndarray) -> np.ndarray:
    out: np.ndarray = (targets.astype(int) << np.arange(targets.shape[-1])).sum(-1)
    return out


def replay(s: Sim, targets: np.ndarray) -> float:
    """The categories won a week per matchup when each team streams for ``targets`` [L, D, 9]
    against each other team, the opponent unchanged."""
    i, j = directed(s.xt.shape[1])
    add = np.take_along_axis(s.best, _codes(targets), axis=1)  # [L, D]
    plus = np.where((add >= 0)[..., None], s.x[np.maximum(add, 0)], 0.0)
    won = beat(cat_values(s.xt[:, i] + plus), cat_values(s.xt[:, j])).sum(-1)
    return float(won.mean())


def arm_targets(s: Sim, sigma: np.ndarray, band: float) -> dict[str, np.ndarray]:
    """What each arm streams for in every directed matchup: the categories not called a win."""
    i, j = directed(s.xt.shape[1])
    edge, chance, share = card.chances(s.proj[:, i], s.proj[:, j], s.g[:, i], s.g[:, j], sigma)
    _, naive_chance, _ = card.chances(s.naive[:, i], s.naive[:, j], s.g[:, i], s.g[:, j], sigma)
    return {
        "band": ~card.called_wins(chance, band),
        "share": ~((share > SHARE_RULE) & (edge > 0)),
        "losing": ~(edge > 0),
        "naive": ~card.called_wins(naive_chance, band),
    }


# ---- judging ---------------------------------------------------------------------------------


def weighted_slope(x: np.ndarray, y: np.ndarray, w: np.ndarray) -> float:
    """The slope of a weighted logistic fit of y (0 to 1) on x, with an intercept: Newton steps,
    each halved until the likelihood improves."""

    def nll(a: float, b: float) -> float:
        eta = a + b * x
        return float(np.sum(w * (np.logaddexp(0, eta) - y * eta)))

    a, b = 0.0, 1.0
    cur = nll(a, b)
    for _ in range(100):
        mu = 0.5 * (1 + np.tanh((a + b * x) / 2))
        v = w * mu * (1 - mu)
        r = w * (y - mu)
        h = np.array([[v.sum(), (v * x).sum()], [(v * x).sum(), (v * x * x).sum()]])
        step = np.linalg.lstsq(h, np.array([r.sum(), (r * x).sum()]), rcond=None)[0]
        t = 1.0
        while t > 1e-8 and nll(a + t * step[0], b + t * step[1]) > cur:
            t /= 2
        if t <= 1e-8:
            break
        a, b = a + t * step[0], b + t * step[1]
        cur = nll(a, b)
        if np.max(np.abs(t * step)) < 1e-10:
            break
    return float(b)


def _logit(p: np.ndarray) -> np.ndarray:
    q = np.clip(p, 1e-9, 1 - 1e-9)
    out: np.ndarray = np.log(q / (1 - q))
    return out


@dataclass
class WeekFigures:
    sq: dict[str, float]  # model, naive, coin: summed squared errors
    n: int  # items
    x: np.ndarray  # logit of the model's chances, a sample for the slope
    o: np.ndarray
    won: dict[str, float]  # per arm, categories won a week per matchup
    calls: dict[str, float]  # share of categories called close, per rule
    bins: np.ndarray  # [len(BINS) - 1, 2]: items and the leader's wins per bin of its chance


def week_figures(
    w: Week, p: dict[str, Any], league: str, sigma: np.ndarray, band: float
) -> WeekFigures:
    s = simulate(w, p, league, standings_backtest._seed(w.as_of))
    chance, o = items(s, sigma)
    naive, _ = items(s, sigma, naive=True)
    targets = arm_targets(s, sigma, band)
    i, j = pairs(s.xt.shape[1])
    _, _, share = card.chances(s.proj[:, i], s.proj[:, j], s.g[:, i], s.g[:, j], sigma)
    lead = np.where(chance >= 0.5, chance, 1 - chance)
    lead_won = np.where(chance >= 0.5, o, 1 - o)
    bins = np.array(
        [
            [
                float(((lead >= lo) & (lead < hi)).sum()),
                float(lead_won[(lead >= lo) & (lead < hi)].sum()),
            ]
            for lo, hi in itertools.pairwise(BINS)
        ]
    )
    return WeekFigures(
        sq={
            "model": float(((chance - o) ** 2).sum()),
            "naive": float(((naive - o) ** 2).sum()),
            "coin": float(((0.5 - o) ** 2).sum()),
        },
        n=int(o.size),
        x=_logit(chance).ravel(),
        o=o.ravel(),
        won={arm: replay(s, t) for arm, t in targets.items()},
        calls={
            "band": float((np.abs(chance - 0.5) <= band).mean()),
            "share": float((share <= SHARE_RULE).mean()),
        },
        bins=bins,
    )


def _interval(point: float, draws: np.ndarray) -> list[float]:
    """The point and the percentile 95% interval of its resamples. Every figure here is a mean
    over the weeks, so the resamples need no centring."""
    d = draws[np.isfinite(draws)]
    if not len(d):
        return [float(point), float("nan"), float("nan")]
    lo, hi = np.percentile(d, [2.5, 97.5])
    return [float(point), float(lo), float(hi)]


def judge(season: Season, p: dict[str, Any], *, seed: int = 0) -> dict[str, Any]:
    league = season.league
    sigma = card.sigmas(league, CATS, p)
    band = float(p["matchup.closeness"])
    figs = [week_figures(w, p, league, sigma, band) for w in season.weeks]
    n_weeks = len(figs)
    rng = np.random.default_rng(seed)
    draws = rng.multinomial(
        n_weeks, np.full(n_weeks, 1 / n_weeks), size=int(p["backtest.bootstrap"])
    ).astype(float)
    ones = np.ones(n_weeks)

    def brier(c: np.ndarray, k: str) -> float:
        return float(
            sum(cw * f.sq[k] for cw, f in zip(c, figs, strict=True)) / (c @ [f.n for f in figs])
        )

    def won(c: np.ndarray, arm: str) -> float:
        return float(sum(cw * f.won[arm] for cw, f in zip(c, figs, strict=True)) / c.sum())

    out: dict[str, Any] = {
        "league": league,
        "season": season.season,
        "weeks": n_weeks,
        "game_spread": dict(zip(CATS, sigma.tolist(), strict=True)),
        "closeness": band,
        "brier": {k: brier(ones, k) for k in ("model", "naive", "coin")},
    }
    for base in ("coin", "naive"):
        out[f"brier_vs_{base}"] = _interval(
            brier(ones, base) - brier(ones, "model"),
            np.array([brier(c, base) - brier(c, "model") for c in draws]),
        )
    x = np.concatenate([f.x for f in figs])
    o = np.concatenate([f.o for f in figs])
    week_of = np.repeat(np.arange(n_weeks), [len(f.x) for f in figs])
    out["slope"] = _interval(
        weighted_slope(x, o, ones[week_of]),
        np.array([weighted_slope(x, o, c[week_of]) for c in draws[::SLOPE_EVERY]]),
    )
    out["won"] = {arm: won(ones, arm) for arm in ARMS}
    for arm in ARMS[1:]:
        out[f"band_vs_{arm}"] = _interval(
            won(ones, "band") - won(ones, arm),
            np.array([won(c, "band") - won(c, arm) for c in draws]),
        )
    out["called_close"] = {k: float(np.mean([f.calls[k] for f in figs])) for k in ("band", "share")}
    total = np.sum([f.bins for f in figs], axis=0)
    out["calibration"] = [
        {"chance": [lo, min(hi, 1.0)], "share": float(t[0] / total[:, 0].sum()),
         "leader_won": float(t[1] / t[0]) if t[0] else None}
        for lo, hi, t in zip(BINS[:-1], BINS[1:], total, strict=True)
    ]  # fmt: skip
    return out


def verdict(result: dict[str, Any]) -> list[str]:
    """The pass bar declared on #869: what fails, empty when everything passes."""
    fails = []
    for base in ("coin", "naive"):
        g = result[f"brier_vs_{base}"]
        if not g[1] > 0:
            fails.append(f"the card's chances do not beat the {base} (Brier) {g}")
    if not SLOPE[0] <= result["slope"][0] <= SLOPE[1]:
        fails.append(f"calibration slope {result['slope'][0]:.3f} outside {SLOPE}")
    for arm in ("share", "losing"):
        g = result[f"band_vs_{arm}"]
        if g[2] < 0:
            fails.append(f"the band is worse than {arm} in the stream replay {g}")
    return fails


# ---- the fit ---------------------------------------------------------------------------------


def _log_loss(prob: np.ndarray, y: np.ndarray) -> float:
    q = np.clip(prob, 1e-12, 1 - 1e-12)
    return float(-(y * np.log(q) + (1 - y) * np.log(1 - q)).mean())


def fit(seasons: list[Season], p: dict[str, Any]) -> dict[str, Any]:
    """The declared rule: each category's game spread with the lowest log loss of the card's
    chances over the tuning weeks (ties smaller), then the band with the most categories won in
    the stream replay (ties smaller)."""
    league = seasons[0].league
    for s in seasons:
        if s.league != league or s.season not in TUNING[league]:
            msg = (
                f"{s.league} {s.season} is not a tuning season ({sorted(TUNING[league])});"
                " the fit reads only those"
            )
            raise SystemExit(msg)
    sims = [
        simulate(w, p, league, standings_backtest._seed(w.as_of))
        for season in seasons
        for w in season.weeks
    ]
    units = [unit_items(sim) for sim in sims]
    t = np.concatenate([u[0].reshape(-1, len(CATS)) for u in units])
    y = np.concatenate([u[1].reshape(-1, len(CATS)) for u in units])
    spread, losses = [], {}
    for c, cat in enumerate(CATS):
        ok = np.isfinite(t[:, c])
        tc, yc = t[ok, c], y[ok, c]
        grid = {k: _log_loss(standings.normal_cdf(tc / k), yc) for k in SPREADS}
        pick = min(SPREADS, key=lambda k: (round(grid[k], 12), k))
        spread.append(pick)
        before = float(p["matchup.game_spread"][league][cat])
        losses[cat] = {
            "at_registry": _log_loss(standings.normal_cdf(tc / before), yc),
            "at_pick": grid[pick],
            "coin": _log_loss(np.full_like(yc, 0.5), yc),
        }
    sigma = np.array(spread)
    won = {b: 0.0 for b in BANDS}
    for sim in sims:
        i, j = directed(sim.xt.shape[1])
        _, chance, _ = card.chances(sim.proj[:, i], sim.proj[:, j], sim.g[:, i], sim.g[:, j], sigma)
        for b in BANDS:
            won[b] += replay(sim, ~card.called_wins(chance, b)) / len(sims)
    band = min(BANDS, key=lambda b: (-round(won[b], 12), b))
    return {
        "league": league,
        "seasons": sorted(season.season for season in seasons),
        "weeks": len(sims),
        "game_spread": dict(zip(CATS, spread, strict=True)),
        "log_loss": losses,
        "closeness": band,
        "replay_grid": won,
    }


# ---- the command line ------------------------------------------------------------------------


def _iv(v: list[float], f: str = "+.4f") -> str:
    return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"


def report(res: dict[str, Any]) -> str:
    b = res["brier"]
    lines = [
        f"{res['league']} {res['season']}, {res['weeks']} weeks; closeness {res['closeness']}",
        f"Brier model {b['model']:.4f}, naive {b['naive']:.4f}, coin {b['coin']:.4f};"
        f" vs coin {_iv(res['brier_vs_coin'])}, vs naive {_iv(res['brier_vs_naive'])};"
        f" slope {_iv(res['slope'], '.3f')}",
        "stream replay, categories won a week: "
        + ", ".join(f"{a} {v:.4f}" for a, v in res["won"].items())
        + "; band minus "
        + "; ".join(f"{a} {_iv(res[f'band_vs_{a}'])}" for a in ARMS[1:]),
        f"called close: band {res['called_close']['band']:.1%},"
        f" share rule {res['called_close']['share']:.1%}",
        "leader's chance -> share of categories, leader won: "
        + "; ".join(
            f"{c['chance'][0]:.1f}-{c['chance'][1]:.1f} {c['share']:.1%}"
            + (f" {c['leader_won']:.3f}" if c["leader_won"] is not None else "")
            for c in res["calibration"]
        ),
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="build every week of a season and hand over the boards")
    e.add_argument("--league", choices=("nba", "wnba"), required=True)
    e.add_argument("--season", required=True)
    e.add_argument("--full-db", type=Path, default=walk_forward.DBT / "fantasyscout.duckdb")
    e.add_argument("--out", type=Path, required=True)
    e.add_argument("--judge-locked", action="store_true", help="the held-out season, once")
    j = sub.add_parser("judge", help="judge one season's weeks against the bar")
    j.add_argument("folder", type=Path)
    j.add_argument("--out", type=Path)
    j.add_argument("--judge-locked", action="store_true", help="the held-out season, once")
    f = sub.add_parser("fit", help="fit the game spreads and the band on the tuning seasons")
    f.add_argument("folders", type=Path, nargs="+")
    f.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    if args.cmd == "export":
        if LOCKED.get(args.league) == args.season and not args.judge_locked:
            print(f"{args.league} {args.season} is held out (#751)", file=sys.stderr)
            return 2
        export(args.full_db, args.league, args.season, args.out)
        return 0
    p = standings.registry()
    if args.cmd == "fit":
        res = fit([load(d) for d in args.folders], p)
        print(json.dumps(res, indent=2))
        if args.out:
            grid = {str(k): v for k, v in res["replay_grid"].items()}
            text = json.dumps({**res, "replay_grid": grid}, indent=2)
            args.out.write_text(text + "\n", encoding="utf-8")
        return 0
    season = load(args.folder)
    if LOCKED.get(season.league) == season.season and not args.judge_locked:
        print(f"{season.league} {season.season} is held out (#751)", file=sys.stderr)
        return 2
    res = judge(season, p)
    print(report(res))
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
