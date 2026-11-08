"""Walk-forward backtest of the standings model (#755, ADR 0015): category win chances, power
rankings and Fit, judged on simulated leagues of real seasons.

    uv run python -m ops.walk_forward --league nba --season 2023-24 --standings-out standings/
    uv run python -m ops.standings_backtest judge standings/ --out standings.json
    uv run python -m ops.standings_backtest fit tuning-2020-21/ tuning-2021-22/ tuning-2022-23/

There are no past fantasy leagues to replay, so the harness drafts them. At each checkpoint
(point-in-time builds, ADR 0018) it drafts ``backtest.standings_leagues`` leagues of the default
size: a snake draft, each pick drawn at random from the ``backtest.standings_draft_choice`` best
players left by the board's category value. The rosters are held for the rest of the season with
every player active. The model's figures come from ops.standings, the web's arithmetic. What
happened comes from the real regular-season box scores, in fantasy weeks (Monday to Sunday) after
the cut: a category is won on raw totals (fewer turnovers; FG% and FT% as makes over attempts), a
tie counting half; rotisserie compares the rest-of-season totals.

Each format, head-to-head and rotisserie, is judged on:

- **win chances:** the Brier score against a coin flip and the naive manager (the same model on
  each player's season so far, last season's line before they have played, with no
  availability), and the calibration slope (outcome on logit(chance));
- **power rankings:** the Spearman correlation, league by league, of the predicted order with what
  happened (the all-play matchup record, or the rotisserie points), against the naive manager's
  summed values, the plain category totals and the market's mean draft rank;
- **Fit, by decision replay:** each team adds one free agent and drops its lowest rest-of-season
  value; the add is picked by Fit (the standings weights), by Value (equal weights), by the
  fit.thirds fallback, by the naive manager and by the market. The outcome is the team's realized
  categories won a week against each other team, or its rotisserie points.

Intervals are 95%, from ``backtest.bootstrap`` resamples of the season's weeks: every simulated
league shares the same games, so the week is what varies. The pass bar was declared on #755
before any run; ``verdict`` applies it. ``fit`` reads the tuning seasons only.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import standings
from ops.standings import CATS
from ops.walk_forward import LOCKED, score_terms

STATS = (
    "points",
    "rebounds_total",
    "assists",
    "steals",
    "blocks",
    "three_pointers_made",
    "turnovers",
    "field_goals_made",
    "field_goals_attempted",
    "free_throws_made",
    "free_throws_attempted",
)
NAIVE = tuple(f"naive_{c}" for c in CATS)
# declared on #755 before any run: the fit reads these, the judgement the next two
TUNING = {"nba": {"2020-21", "2021-22", "2022-23"}, "wnba": {"2021", "2022", "2023"}}
JUDGED = {"nba": {"2023-24", "2024-25"}, "wnba": {"2024", "2025"}}
SCALES = tuple(round(0.5 + 0.05 * i, 2) for i in range(31))
PROJECTIONS = tuple(round(0.05 * i, 2) for i in range(31))
SLOPE = (0.8, 1.25)
# the calibration slope's interval refits every this many resamples (a logistic fit each); the
# bar gates on its point estimate
SLOPE_EVERY = 10
ARMS = ("fit", "value", "thirds", "naive", "market")
FORMATS = ("h2h", "roto")


# ---- what a checkpoint's build hands over ---------------------------------------------------


def export_checkpoint(cut: Any, league: str, season: str, as_of: date, out: Path) -> None:
    """The board's players at a checkpoint: category values, availability, the rest-of-season
    value, the naive manager's category values and the draft rank. ``cut`` is the checkpoint's
    point-in-time build."""
    naive = ", ".join(f"{t} as {c}" for t, c in zip(score_terms("n", "s"), NAIVE, strict=True))
    sql = f"""
        with board as (select * from gold.mart_board where league = $league),
        scale as (
            select s.* from gold.int_value_scale as s
            join (select distinct league, season from board) as b
                on b.league = s.league and b.season = s.season
        ),
        naive_line as (
            select * from gold.int_player_window_lines
            where league = $league and window_name = 'season' and season <= $season
            qualify row_number() over (partition by player_id order by season desc) = 1
        ),
        market as (
            select x.stats_player_id as player_id, min(a.adp_rank) as adp_rank
            from silver.espn_preseason_adp as a
            join silver.player_xwalk as x
                on x.league = a.league and x.espn_player_id = a.espn_player_id
            where a.league = $league and a.season = $season
            group by x.stats_player_id
        )
        select b.player_id, {", ".join(f"b.{c}" for c in CATS)}, b.availability_multiplier,
            b.games_share, b.ros_factor, b.value_rest_of_season, b.games_remaining, m.adp_rank,
            {naive}
        from board as b
        cross join scale as s
        left join naive_line as n on n.player_id = b.player_id
        left join market as m on m.player_id = b.player_id
    """
    df = cut.execute(sql, {"league": league, "season": season}).fetchdf()
    df.to_csv(out / f"players-{as_of.isoformat()}.csv", index=False)


def export_weeks(full: Any, league: str, season: str, first: date, out: Path) -> None:
    """Every player's regular-season box-score totals per fantasy week (Monday to Sunday)."""
    sums = ", ".join(f"sum(coalesce({s}, 0)) as {s}" for s in STATS)
    sql = f"""
        select player_id, date_trunc('week', game_date)::date as week, count(*) as games, {sums}
        from gold.fct_player_game
        where league = $league and season = $season and played
            and substr(game_id, 3, 1) = '2' and game_date >= $first
        group by all
    """
    df = full.execute(sql, {"league": league, "season": season, "first": first}).fetchdf()
    df.to_csv(out / "weeks.csv", index=False)


# ---- loading ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Cut:
    as_of: date
    z: np.ndarray  # [P, 9] category values above replacement
    naive: np.ndarray  # [P, 9]
    avail: np.ndarray  # [P]
    games_share: np.ndarray
    ros_factor: np.ndarray
    rest_value: np.ndarray
    adp: np.ndarray  # nan: undrafted or no draft order
    games_left: float
    weeks: np.ndarray  # indices of the season's weeks that start on or after the cut
    x: np.ndarray  # [W, P, 11] box-score totals in those weeks


@dataclass(frozen=True)
class Season:
    league: str
    season: str
    weeks: list[date]
    cuts: list[Cut]


def _col(df: pd.DataFrame, name: str, fill: float) -> np.ndarray:
    out: np.ndarray = df[name].astype(float).fillna(fill).to_numpy()
    return out


def load(folder: Path) -> Season:
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    weeks_df = pd.read_csv(folder / "weeks.csv", parse_dates=["week"], dtype={"player_id": str})
    weeks = sorted({d.date() for d in weeks_df["week"]})
    week_index = {d: i for i, d in enumerate(weeks)}
    cuts = []
    for as_of_text in meta["checkpoints"]:
        as_of = date.fromisoformat(as_of_text)
        df = pd.read_csv(folder / f"players-{as_of_text}.csv", dtype={"player_id": str})
        ids = {pid: i for i, pid in enumerate(df["player_id"])}
        mine = [i for i, d in enumerate(weeks) if d >= as_of]
        x = np.zeros((len(mine), len(df), len(STATS)))
        pos = {w: k for k, w in enumerate(mine)}
        rows = weeks_df[weeks_df["player_id"].isin(ids.keys())]
        for r in rows.itertuples(index=False):
            w = week_index[r.week.date()]
            if w in pos:
                x[pos[w], ids[r.player_id]] = [getattr(r, s) for s in STATS]
        cuts.append(
            Cut(
                as_of=as_of,
                z=df[list(CATS)].astype(float).fillna(0).to_numpy(),
                naive=df[list(NAIVE)].astype(float).fillna(0).to_numpy(),
                avail=_col(df, "availability_multiplier", 1),
                games_share=_col(df, "games_share", 1),
                ros_factor=_col(df, "ros_factor", 1),
                rest_value=_col(df, "value_rest_of_season", 0),
                adp=df["adp_rank"].astype(float).to_numpy(),
                games_left=float(df["games_remaining"].fillna(0).max()),
                weeks=np.array(mine, dtype=int),
                x=x,
            )
        )
    return Season(meta["league"], meta["season"], weeks, cuts)


# ---- the simulated leagues -------------------------------------------------------------------


def draft(
    rng: np.random.Generator, value: np.ndarray, leagues: int, teams: int, spots: int, choice: int
) -> np.ndarray:
    """Snake drafts, each pick drawn at random from the ``choice`` best left: [leagues, teams,
    spots] player indices."""
    if len(value) < teams * spots:
        msg = f"{len(value)} players cannot fill {teams} x {spots} roster spots"
        raise SystemExit(msg)
    order = list(np.argsort(-value, kind="stable"))
    out = np.empty((leagues, teams, spots), dtype=int)
    for lg in range(leagues):
        left = list(order)
        for r in range(spots):
            for t in range(teams) if r % 2 == 0 else range(teams - 1, -1, -1):
                out[lg, t, r] = left.pop(int(rng.integers(0, min(choice, len(left)))))
    return out


def cat_values(x: np.ndarray) -> np.ndarray:
    """Box-score totals [..., 11] as nine numbers where more is better (turnovers negated, the
    percentages as makes over attempts; no attempts below any)."""

    def pct(made: np.ndarray, att: np.ndarray) -> np.ndarray:
        return np.where(att > 0, made / np.where(att > 0, att, 1), -np.inf)[..., None]

    return np.concatenate(
        [x[..., :6], -x[..., 6:7], pct(x[..., 7], x[..., 8]), pct(x[..., 9], x[..., 10])], axis=-1
    )


def beat(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.where(a > b, 1.0, np.where(a < b, 0.0, 0.5))


def avg_ranks(a: np.ndarray) -> np.ndarray:
    """Ranks along the last axis, ties sharing their average."""
    out: np.ndarray = pd.DataFrame(a.reshape(-1, a.shape[-1])).rank(axis=1).to_numpy()
    return out.reshape(a.shape)


def spearman_rows(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ra, rb = avg_ranks(a), avg_ranks(b)
    ra, rb = ra - ra.mean(-1, keepdims=True), rb - rb.mean(-1, keepdims=True)
    den = np.sqrt((ra**2).sum(-1) * (rb**2).sum(-1))
    return np.where(den > 0, (ra * rb).sum(-1) / np.where(den > 0, den, 1), np.nan)


def logistic_slope(x: np.ndarray, y: np.ndarray) -> float:
    """The slope of a logistic fit of y (0 to 1) on x, with an intercept (Newton)."""
    a, b = 0.0, 1.0
    for _ in range(50):
        mu = 1 / (1 + np.exp(-(a + b * x)))
        w = mu * (1 - mu)
        r = y - mu
        h = np.array([[w.sum(), (w * x).sum()], [(w * x).sum(), (w * x * x).sum()]])
        step = np.linalg.solve(h, np.array([r.sum(), (r * x).sum()]))
        a, b = a + step[0], b + step[1]
        if np.max(np.abs(step)) < 1e-10:
            break
    return float(b)


def _logit(p: np.ndarray) -> np.ndarray:
    q = np.clip(p, 1e-9, 1 - 1e-9)
    out: np.ndarray = np.log(q / (1 - q))
    return out


@dataclass
class League:
    """One checkpoint's simulated leagues, what the model said and what happened."""

    rost: np.ndarray  # [L, T, R]
    xt: np.ndarray  # [W, L, T, 11] each team's weekly totals
    tot: np.ndarray  # [L, T, 9] the model's totals (values x availability)
    naive_tot: np.ndarray  # [L, T, 9]
    n: np.ndarray  # [L] availability-weighted players a team
    spots: int


def simulate(cut: Cut, p: dict[str, Any], league: str, seed: int) -> League:
    teams = int(p["scale.teams"][league])
    spots = int(p["scale.roster_spots"][league])
    rng = np.random.default_rng(seed)
    rost = draft(
        rng,
        cut.z.sum(1),
        int(p["backtest.standings_leagues"]),
        teams,
        spots,
        int(p["backtest.standings_draft_choice"]),
    )
    return League(
        rost=rost,
        xt=cut.x[:, rost].sum(axis=3),
        tot=(cut.z[rost] * cut.avail[rost][..., None]).sum(axis=2),
        naive_tot=cut.naive[rost].sum(axis=2),
        n=cut.avail[rost].sum(axis=2).mean(axis=1),
        spots=spots,
    )


def pairs(teams: int) -> tuple[np.ndarray, np.ndarray]:
    i, j = np.triu_indices(teams, 1)
    return i, j


def pair_chances(tot: np.ndarray, spread: np.ndarray) -> np.ndarray:
    """[L, K, 9]: the first team of each pair finishing ahead."""
    i, j = pairs(tot.shape[1])
    out: np.ndarray = standings.chance(tot[:, i] - tot[:, j], spread[:, None, :])
    return out


def per_team(pair_values: np.ndarray, teams: int) -> np.ndarray:
    """Sum of a pairwise figure [L, K] for the first team plus its complement for the second."""
    i, j = pairs(teams)
    first = np.eye(teams)[i]  # [K, T]: which team is first in each pair
    second = np.eye(teams)[j]
    out: np.ndarray = pair_values @ first + (1 - pair_values) @ second
    return out


def fit_weights(tot: np.ndarray, spread: np.ndarray) -> np.ndarray:
    """standingWeights for every team of every league: [L, T, 9]."""
    d = (tot[:, :, None, :] - tot[:, None, :, :]) / spread[:, None, None, :]
    dens = standings.normal_pdf(d) / spread[:, None, None, :]
    teams = tot.shape[1]
    off = ~np.eye(teams, dtype=bool)
    raw = (dens * off[None, :, :, None]).sum(axis=2) / (teams - 1)
    mean = raw.mean(-1, keepdims=True)
    return np.where(mean > 0, raw / np.where(mean > 0, mean, 1), 1.0)


def thirds(tot: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    w = p["fit.thirds"]
    order = np.argsort(tot, axis=-1, kind="stable")
    k = tot.shape[-1]
    third = max(1, standings._js_round(k / 3))
    by_place = np.array(
        [
            w["weak"] if i < third else w["strong"] if i >= k - third else w["middle"]
            for i in range(k)
        ],
        dtype=float,
    )
    out = np.empty_like(tot)
    np.put_along_axis(out, order, np.broadcast_to(by_place, tot.shape), axis=-1)
    return out


def adds(cut: Cut, lg: League, weights: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Each arm's free-agent add for every team [L, T]: the best by its score among the players
    no team in the league rosters."""
    n_leagues, teams, _ = lg.rost.shape
    free = np.ones((n_leagues, len(cut.z)), dtype=bool)
    np.put_along_axis(free, lg.rost.reshape(n_leagues, -1), False, axis=1)
    out: dict[str, np.ndarray] = {}
    for arm, w in weights.items():
        v = np.einsum("ltc,pc->ltp", w, cut.z)
        v = np.where(v > 0, v * cut.games_share * cut.ros_factor, v)
        out[arm] = np.argmax(np.where(free[:, None, :], v, -np.inf), axis=-1)
    naive = np.where(free, cut.naive.sum(1), -np.inf)
    out["naive"] = np.broadcast_to(np.argmax(naive, axis=-1)[:, None], (n_leagues, teams))
    if np.isfinite(cut.adp).any():
        market = np.where(free & np.isfinite(cut.adp), -np.nan_to_num(cut.adp, nan=np.inf), -np.inf)
        out["market"] = np.broadcast_to(np.argmax(market, axis=-1)[:, None], (n_leagues, teams))
    return out


# ---- one checkpoint's figures ----------------------------------------------------------------


@dataclass
class Figures:
    """What a checkpoint's judgement needs, per week where the outcome is weekly, so a resample
    of the weeks re-weighs them."""

    h2h_sq: dict[str, np.ndarray]  # model, naive, coin: [W] summed squared errors
    h2h_items: int
    h2h_x: np.ndarray  # [items] logit of the model's chance
    h2h_o: np.ndarray  # [W, items] outcomes
    record: np.ndarray  # [W, L, T] all-play matchups won
    h2h_pred: dict[str, np.ndarray]  # [L, T] predicted orders
    roto_p: dict[str, np.ndarray]  # model, naive: [L, K, 9]
    roto_pred: dict[str, np.ndarray]
    xt: np.ndarray  # [W, L, T, 11]
    fit_h2h: np.ndarray  # [W, L, T, A] categories won a week per rival, per arm
    xt_new: dict[str, np.ndarray]  # roto: per format's adds [W, L, T, A, 11]
    arms: tuple[str, ...]


def figures(cut: Cut, p: dict[str, Any], league: str, seed: int) -> Figures:
    lg = simulate(cut, p, league, seed)
    teams = lg.rost.shape[1]
    i, j = pairs(teams)
    cv = cat_values(lg.xt)
    o = beat(cv[:, :, i], cv[:, :, j])  # [W, L, K, 9]
    s_h2h = standings.spreads(league, CATS, lg.n, "h2h", p=p)
    s_naive = standings.spreads(league, CATS, np.full_like(lg.n, lg.spots), "h2h", p=p)
    ph = pair_chances(lg.tot, s_h2h)
    pn = pair_chances(lg.naive_tot, s_naive)
    sq = {
        "model": ((ph[None] - o) ** 2).sum(axis=(1, 2, 3)),
        "naive": ((pn[None] - o) ** 2).sum(axis=(1, 2, 3)),
        "coin": ((0.5 - o) ** 2).sum(axis=(1, 2, 3)),
    }
    won = o.sum(-1)
    half = len(CATS) / 2
    result = np.where(won > half, 1.0, np.where(won == half, 0.5, 0.0))  # [W, L, K]
    record = np.stack([per_team(r, teams) for r in result])  # [W, L, T]
    market = np.nan_to_num(cut.adp, nan=np.nanmax(cut.adp) + 1 if np.isfinite(cut.adp).any() else 0)
    common = {
        "naive": lg.naive_tot.sum(-1),
        "totals": lg.tot.sum(-1),
        **({"market": -market[lg.rost].mean(-1)} if np.isfinite(cut.adp).any() else {}),
    }
    h2h_pred = {"model": per_team(standings.matchup_chance(ph), teams) / (teams - 1), **common}
    s_roto = standings.spreads(league, CATS, lg.n, "roto", cut.games_left, p=p)
    s_roto_naive = standings.spreads(
        league, CATS, np.full_like(lg.n, lg.spots), "roto", cut.games_left, p=p
    )
    pr = pair_chances(lg.tot, s_roto)
    roto_pred = {"model": len(CATS) + per_team_cats(pr, teams), **common}
    fit_h2h, xt_new = replay(cut, lg, p, {"h2h": s_h2h, "roto": s_roto})
    return Figures(
        h2h_sq=sq,
        h2h_items=int(np.prod(o.shape[1:])),
        h2h_x=_logit(ph).ravel(),
        h2h_o=o.reshape(o.shape[0], -1),
        record=record,
        h2h_pred=h2h_pred,
        roto_p={"model": pr, "naive": pair_chances(lg.naive_tot, s_roto_naive)},
        roto_pred=roto_pred,
        xt=lg.xt,
        fit_h2h=fit_h2h,
        xt_new=xt_new,
        arms=tuple(a for a in ARMS if a != "market" or np.isfinite(cut.adp).any()),
    )


def per_team_cats(pair_chance: np.ndarray, teams: int) -> np.ndarray:
    """Categories' chances [L, K, 9] summed into each team's rivals beaten [L, T]."""
    k = pair_chance.shape[-1]
    out: np.ndarray = per_team(pair_chance.sum(-1) / k, teams) * k
    return out


def replay(
    cut: Cut, lg: League, p: dict[str, Any], spread: dict[str, np.ndarray]
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """The decision replay: per format's Fit weights, each arm's add and the team after it.
    Returns the head-to-head categories won a week per rival [W, L, T, A] and, per format, the
    teams' weekly totals after each arm's move [W, L, T, A, 11]."""
    drop = np.take_along_axis(
        lg.rost, np.argmin(cut.rest_value[lg.rost], axis=-1)[..., None], axis=-1
    )[..., 0]
    base = lg.xt - cut.x[:, drop]  # [W, L, T, 11]
    teams = lg.rost.shape[1]
    off = ~np.eye(teams, dtype=bool)
    cv = cat_values(lg.xt)
    xt_new: dict[str, np.ndarray] = {}
    fit_h2h = None
    for fmt in FORMATS:
        weights = {
            "fit": fit_weights(lg.tot, spread[fmt]),
            "value": np.ones_like(lg.tot),
            "thirds": thirds(lg.tot, p),
        }
        picks = adds(cut, lg, weights)
        new = np.stack([base + cut.x[:, picks[a]] for a in ARMS if a in picks], axis=3)
        xt_new[fmt] = new
        if fmt == "h2h":
            won = []
            for a in range(new.shape[3]):
                w = beat(cat_values(new[:, :, :, a])[:, :, :, None, :], cv[:, :, None, :, :]).sum(
                    -1
                )
                won.append((w * off).sum(-1) / (teams - 1))
            fit_h2h = np.stack(won, axis=-1)
    assert fit_h2h is not None
    return fit_h2h, xt_new


# ---- judging ---------------------------------------------------------------------------------


def _interval(point: float, draws: np.ndarray) -> list[float]:
    """The point and the 95% interval of its resamples, centred on the point: a resample of the
    weeks repeats some and drops others, which adds noise to every season total built from them
    and so pulls a figure read off those totals (a Spearman, a rotisserie Brier) below the
    point. The resamples give the spread; the centring removes that pull."""
    d = draws[np.isfinite(draws)]
    if not len(d):
        return [float(point), math.nan, math.nan]
    lo, mid, hi = np.percentile(d, [2.5, 50, 97.5])
    return [float(point), float(lo + point - mid), float(hi + point - mid)]


def _roto_eval(f: Figures, c: np.ndarray) -> dict[str, Any]:
    """Rotisserie figures for one weighting of the weeks."""
    xt = np.tensordot(c, f.xt, axes=(0, 0))
    cv = cat_values(xt)
    teams = xt.shape[1]
    i, j = pairs(teams)
    o = beat(cv[:, i], cv[:, j])
    brier = {k: float(((v - o) ** 2).mean()) for k, v in f.roto_p.items()}
    brier["coin"] = float(((0.5 - o) ** 2).mean())
    points = len(CATS) + per_team_cats(o, teams)
    spear = {k: float(np.nanmean(spearman_rows(v, points))) for k, v in f.roto_pred.items()}
    off = ~np.eye(teams, dtype=bool)
    arm_points = []
    new = np.tensordot(c, f.xt_new["roto"], axes=(0, 0))  # [L, T, A, 11]
    for a in range(new.shape[2]):
        b = beat(cat_values(new[:, :, a])[:, :, None, :], cv[:, None, :, :]).sum(-1)
        arm_points.append(len(CATS) + (b * off).sum(-1))
    pts = np.stack(arm_points, axis=-1).mean(axis=(0, 1))
    return {"brier": brier, "spearman": spear, "fit": pts, "o": o}


def _h2h_eval(f: Figures, c: np.ndarray) -> dict[str, Any]:
    tot = c.sum()
    brier = {k: float((c * v).sum() / (tot * f.h2h_items)) for k, v in f.h2h_sq.items()}
    record = np.tensordot(c, f.record, axes=(0, 0))
    spear = {k: float(np.nanmean(spearman_rows(v, record))) for k, v in f.h2h_pred.items()}
    fit = np.tensordot(c, f.fit_h2h, axes=(0, 0)).mean(axis=(0, 1)) / tot
    return {"brier": brier, "spearman": spear, "fit": fit}


def judge_cut(f: Figures, draws: np.ndarray) -> dict[str, Any]:
    """One checkpoint: point figures and intervals. ``draws`` [B, W] are the week weights."""
    ones = np.ones(f.xt.shape[0])
    out: dict[str, Any] = {"weeks": len(ones), "leagues": int(f.xt.shape[1])}
    for fmt, ev in (("h2h", _h2h_eval), ("roto", _roto_eval)):
        point = ev(f, ones)
        boots = [ev(f, c) for c in draws if c.sum() > 0]
        res: dict[str, Any] = {"brier": point["brier"]}
        for base in ("coin", "naive"):
            res[f"brier_vs_{base}"] = _interval(
                point["brier"][base] - point["brier"]["model"],
                np.array([b["brier"][base] - b["brier"]["model"] for b in boots]),
            )
        res["spearman"] = {
            k: _interval(v, np.array([b["spearman"][k] for b in boots]))
            for k, v in point["spearman"].items()
        }
        for base in point["spearman"]:
            if base != "model":
                res[f"spearman_vs_{base}"] = _interval(
                    point["spearman"]["model"] - point["spearman"][base],
                    np.array([b["spearman"]["model"] - b["spearman"][base] for b in boots]),
                )
        res["fit"] = {a: float(point["fit"][k]) for k, a in enumerate(f.arms)}
        res["_fit_draws"] = np.array([b["fit"] for b in boots])
        res["_fit_point"] = point["fit"]
        if fmt == "h2h":
            res["slope"] = _interval(
                logistic_slope(f.h2h_x, f.h2h_o.mean(0)), _h2h_slopes(f, draws)
            )
        else:
            x = _logit(f.roto_p["model"]).ravel()
            slopes = np.array([logistic_slope(x, b["o"].ravel()) for b in boots[::SLOPE_EVERY]])
            res["slope"] = _interval(logistic_slope(x, point["o"].ravel()), slopes)
        out[fmt] = res
    return out


def _h2h_slopes(f: Figures, draws: np.ndarray) -> np.ndarray:
    """The calibration slope's resamples, every SLOPE_EVERY-th draw (each a full logistic fit)."""
    out = []
    for c in draws[::SLOPE_EVERY]:
        if c.sum() > 0:
            out.append(logistic_slope(f.h2h_x, (c @ f.h2h_o) / c.sum()))
    return np.array(out)


def judge(season: Season, p: dict[str, Any], *, seed: int = 0) -> dict[str, Any]:
    resamples = int(p["backtest.bootstrap"])
    rng = np.random.default_rng(seed)
    draws = rng.multinomial(
        len(season.weeks), np.full(len(season.weeks), 1 / len(season.weeks)), size=resamples
    ).astype(float)
    cuts = []
    pooled: dict[str, list[Any]] = {fmt: [] for fmt in FORMATS}
    arms: tuple[str, ...] = ARMS
    for cut in season.cuts:
        f = figures(cut, p, season.league, _seed(cut.as_of))
        arms = f.arms
        res = judge_cut(f, draws[:, cut.weeks])
        res["as_of"] = cut.as_of.isoformat()
        for fmt in FORMATS:
            pooled[fmt].append((res[fmt].pop("_fit_point"), res[fmt].pop("_fit_draws"), cut.weeks))
        cuts.append(res)
    fit = {fmt: _pooled_fit(pooled[fmt], arms, draws) for fmt in FORMATS}
    return {
        "league": season.league,
        "season": season.season,
        "checkpoints": cuts,
        "fit_pooled": fit,
    }


def _pooled_fit(
    per_cut: list[Any], arms: tuple[str, ...], draws: np.ndarray
) -> dict[str, list[float]]:
    """Fit minus each arm, averaged over the checkpoints, with the same week resamples for all.
    A resample that leaves a checkpoint no weeks is dropped from every checkpoint."""
    keep = np.all([draws[:, w].sum(1) > 0 for _, _, w in per_cut], axis=0)
    out = {}
    for k, arm in enumerate(arms):
        if arm == "fit":
            continue
        point = float(np.mean([pt[0] - pt[k] for pt, _, _ in per_cut]))
        boot = np.zeros(int(keep.sum()))
        for _, d, w in per_cut:
            ok = draws[:, w].sum(1) > 0
            boot += (d[:, 0] - d[:, k])[keep[ok]]
        out[arm] = _interval(point, boot / len(per_cut))
    return out


def _seed(as_of: date) -> int:
    return int(as_of.strftime("%Y%m%d"))


def verdict(result: dict[str, Any]) -> list[str]:
    """The pass bar declared on #755: what fails, empty when everything passes."""
    fails = []
    for i, cp in enumerate(result["checkpoints"]):
        first = i == 0
        for fmt in FORMATS:
            r = cp[fmt]
            where = f"{fmt} {cp['as_of']}"
            if not r["brier_vs_coin"][1] > 0:
                fails.append(f"{where}: win chances do not beat a coin flip {r['brier_vs_coin']}")
            naive = r["brier_vs_naive"]
            if (naive[2] < 0) if first else not naive[1] > 0:
                fails.append(f"{where}: win chances vs the naive manager {naive}")
            if not SLOPE[0] <= r["slope"][0] <= SLOPE[1]:
                fails.append(f"{where}: calibration slope {r['slope'][0]:.3f} outside {SLOPE}")
            if not r["spearman"]["model"][1] > 0:
                fails.append(f"{where}: power rankings' Spearman {r['spearman']['model']}")
            sn = r["spearman_vs_naive"]
            if (sn[2] < 0) if first else not sn[1] > 0:
                fails.append(f"{where}: power rankings vs the naive manager {sn}")
    for fmt, gaps in result["fit_pooled"].items():
        for arm, need_beat in (("value", True), ("naive", True), ("thirds", False)):
            g = gaps[arm]
            if (not g[1] > 0) if need_beat else g[2] < 0:
                fails.append(f"{fmt} Fit vs {arm}, pooled: {g}")
    return fails


# ---- the fit ---------------------------------------------------------------------------------


def _log_loss(prob: np.ndarray, wins: np.ndarray, trials: float) -> float:
    q = np.clip(prob, 1e-12, 1 - 1e-12)
    return float(-(wins * np.log(q) + (trials - wins) * np.log(1 - q)).sum() / (trials * prob.size))


def fit(seasons: list[Season], p: dict[str, Any]) -> dict[str, Any]:
    """The declared rule: the spread scale with the lowest mean head-to-head log loss over the
    tuning checkpoints (ties nearer 1), then the projection spread with the lowest rotisserie one
    (ties smaller)."""
    league = seasons[0].league
    for s in seasons:
        if s.league != league or s.season not in TUNING[league]:
            msg = (
                f"{s.league} {s.season} is not a tuning season ({sorted(TUNING[league])});"
                " the fit reads only those"
            )
            raise SystemExit(msg)
    cases = []
    for s in seasons:
        for cut in s.cuts:
            lg = simulate(cut, p, league, _seed(cut.as_of))
            i, j = pairs(lg.rost.shape[1])
            cv = cat_values(lg.xt)
            o = beat(cv[:, :, i], cv[:, :, j])
            total = cat_values(lg.xt.sum(0))
            cases.append(
                {
                    "gap": lg.tot[:, i] - lg.tot[:, j],
                    "n": lg.n,
                    "wins": o.sum(0),
                    "weeks": float(o.shape[0]),
                    "roto": beat(total[:, i], total[:, j]),
                    "games_left": cut.games_left,
                }
            )

    def h2h_loss(k: float) -> float:
        return float(
            np.mean(
                [
                    _log_loss(
                        standings.chance(
                            c["gap"],
                            standings.spreads(league, CATS, c["n"], "h2h", p=p, scale=k)[
                                :, None, :
                            ],
                        ),
                        c["wins"],
                        c["weeks"],
                    )
                    for c in cases
                ]
            )
        )

    def roto_loss(k: float, proj: float) -> float:
        return float(
            np.mean(
                [
                    _log_loss(
                        standings.chance(
                            c["gap"],
                            standings.spreads(
                                league,
                                CATS,
                                c["n"],
                                "roto",
                                c["games_left"],
                                p=p,
                                scale=k,
                                projection=proj,
                            )[:, None, :],
                        ),
                        c["roto"],
                        1.0,
                    )
                    for c in cases
                ]
            )
        )

    h2h = {k: h2h_loss(k) for k in SCALES}
    scale = min(SCALES, key=lambda k: (round(h2h[k], 12), abs(k - 1)))
    roto = {q: roto_loss(scale, q) for q in PROJECTIONS}
    projection = min(PROJECTIONS, key=lambda q: (round(roto[q], 12), q))
    return {
        "league": league,
        "seasons": sorted(s.season for s in seasons),
        "checkpoints": len(cases),
        "spread_scale": scale,
        "h2h_log_loss": {"at_1": h2h[1.0], "at_pick": h2h[scale]},
        "projection_spread": projection,
        "roto_log_loss": {
            "at_registry": roto_loss(scale, float(p["standings.projection_spread"][league])),
            "at_pick": roto[projection],
        },
        "h2h_grid": h2h,
        "roto_grid": roto,
    }


# ---- the command line ------------------------------------------------------------------------


def _line(cp: dict[str, Any], fmt: str) -> str:
    r = cp[fmt]

    def iv(v: list[float], f: str = "+.4f") -> str:
        return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"

    b = r["brier"]
    sp = r["spearman"]
    extra = "".join(f", {k} {sp[k][0]:.3f}" for k in ("totals", "market") if k in sp)
    return (
        f"{cp['as_of']} {fmt}: Brier model {b['model']:.4f}, naive {b['naive']:.4f},"
        f" coin {b['coin']:.4f};"
        f" vs coin {iv(r['brier_vs_coin'])}, vs naive {iv(r['brier_vs_naive'])};"
        f" slope {iv(r['slope'], '.3f')}; power Spearman {iv(sp['model'], '.3f')},"
        f" naive {sp['naive'][0]:.3f}{extra}, vs naive {iv(r['spearman_vs_naive'], '+.3f')};"
        f" Fit replay {', '.join(f'{a} {v:.3f}' for a, v in r['fit'].items())}"
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
    f = sub.add_parser(
        "fit", help="fit the spread scale and projection spread on the tuning seasons"
    )
    f.add_argument("folders", type=Path, nargs="+")
    f.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = standings.registry()
    if args.cmd == "fit":
        res = fit([load(d) for d in args.folders], p)
        grids = {k: res.pop(k) for k in ("h2h_grid", "roto_grid")}
        print(json.dumps(res, indent=2))
        if args.out:
            args.out.write_text(
                json.dumps(
                    {**res, **{k: {str(a): b for a, b in v.items()} for k, v in grids.items()}},
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        return 0
    season = load(args.folder)
    if LOCKED.get(season.league) == season.season and not args.judge_locked:
        print(
            f"{season.league} {season.season} is held out and judged once at the end (#751)",
            file=sys.stderr,
        )
        return 2
    res = judge(season, p)
    for cp in res["checkpoints"]:
        for fmt in FORMATS:
            print(_line(cp, fmt))
    for fmt, gaps in res["fit_pooled"].items():
        print(
            f"{fmt} Fit minus each arm, pooled over the checkpoints: "
            + "; ".join(f"{a} {v[0]:+.4f} ({v[1]:+.4f} to {v[2]:+.4f})" for a, v in gaps.items())
        )
    fails = verdict(res)
    res["verdict"] = {"pass": not fails, "fails": fails}
    print(
        "PASS: every condition of the bar holds" if not fails else "FAIL:\n  " + "\n  ".join(fails)
    )
    if args.out:
        args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
