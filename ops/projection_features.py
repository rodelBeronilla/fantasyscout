"""The projection's advanced-stat features, fitted and judged walk-forward (#771).

    uv run python -m ops.projection_features judge --league nba features-*.csv --out features.json

mart_player_projection adjusts its per-minute rates by four features, each off at a neutral value
(var projection_features). ``lines`` is the same arithmetic in Python, applied to the projection's
parts (int_player_projection_parts) that ops.walk_forward writes with ``--features-out`` at every
checkpoint; the harness checks that ``lines`` reproduces the mart's line. So every setting of the
features can be scored here without another build.

The rule was posted on #771 before any run:

- **Seasons.** Coefficients and the selection order are fitted on the tuning seasons only (NBA
  2020-21 to 2022-23, WNBA 2021 to 2023). A feature is judged on NBA 2023-24 and 2024-25, WNBA
  2024 and 2025. The held-out seasons are refused, as the harness refuses them.
- **Score.** The projection's own value per game (the nine categories, before the market prior),
  scored on each checkpoint's scale as built without the features, against what each player then
  did, over the players who then played ``backtest.min_games``.
- **Order.** Forward selection on the tuning seasons: at each step the feature, at its best grid
  point given the features chosen so far, that lowers the pooled tuning RMSE most; a feature that
  lowers it not at all is not chosen.
- **Coefficient.** At each judged step, the grid point with the lowest pooled tuning RMSE given
  the features entered so far.
- **Bar.** A feature enters a league only if, on the judged checkpoints, on minus off: the pooled
  RMSE falls with its 95% paired-bootstrap interval below zero; no checkpoint's RMSE rises by more
  than ``TOLERANCE``; and the pooled Spearman's interval is not wholly below zero. Spearman and
  the top-pool share are reported at every checkpoint with their intervals.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from itertools import product
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import parameters

PRODUCTION = (
    "points",
    "rebounds_total",
    "assists",
    "steals",
    "blocks",
    "three_pointers_made",
    "turnovers",
    "fgm",
    "fga",
    "ftm",
    "fta",
)
# the categories usage moves: the possessions a player ends (shots, free throws, turnovers)
VOLUME = frozenset({"points", "three_pointers_made", "turnovers", "fgm", "fga", "ftm", "fta"})
COUNTING = (
    "points",
    "rebounds_total",
    "assists",
    "steals",
    "blocks",
    "three_pointers_made",
    "turnovers",
)
CATEGORIES = (*COUNTING, "field_goal_pct", "free_throw_pct")
NEUTRAL: dict[str, float] = {
    "pace": 0.0,
    "usage_weight": 1.0,
    "fg_shrink": 0.0,
    "ft_shrink": 0.0,
    "other_team_production": 1.0,
}
TUNING = {"nba": ("2020-21", "2021-22", "2022-23"), "wnba": ("2021", "2022", "2023")}
JUDGED = {"nba": ("2023-24", "2024-25"), "wnba": ("2024", "2025")}
LOCKED = {"nba": "2025-26", "wnba": "2026"}
# the most any judged checkpoint's RMSE may rise, in value per game, for a feature to enter
TOLERANCE = 0.010


@dataclass(frozen=True)
class Feature:
    name: str
    keys: tuple[str, ...]
    # each point gives a value for every key; the neutral point is in every grid
    grid: tuple[tuple[float, ...], ...]


FEATURES: tuple[Feature, ...] = (
    Feature("pace", ("pace",), tuple((b,) for b in (0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5))),
    Feature(
        "usage",
        ("usage_weight",),
        tuple((u,) for u in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0)),
    ),
    Feature(
        "efficiency",
        ("fg_shrink", "ft_shrink"),
        tuple(
            (float(a), float(b))
            for a, b in product((0, 25, 50, 100, 200, 400), (0, 10, 25, 50, 100, 200))
        ),
    ),
    Feature(
        "role",
        ("other_team_production",),
        tuple((r,) for r in (1.0, 0.75, 0.5, 0.25, 0.0)),
    ),
)


def _col(df: pd.DataFrame, name: str) -> np.ndarray:
    out: np.ndarray = df[name].to_numpy(dtype=float)
    return out


def _ratio(num: np.ndarray, den: np.ndarray) -> np.ndarray:
    """num / den, null where den is 0 (SQL's nullif)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        out: np.ndarray = np.where(den == 0, np.nan, num / np.where(den == 0, 1.0, den))
    return out


def lines(parts: pd.DataFrame, s: Mapping[str, float]) -> dict[str, np.ndarray]:
    """The projected per-game line (the eleven production numbers) at feature setting ``s``: the
    arithmetic of mart_player_projection, on int_player_projection_parts' columns."""
    rho = float(s["other_team_production"])
    lam = float(s["usage_weight"])
    beta = float(s["pace"])
    prior_minutes = _col(parts, "prior_minutes")
    rate_weight = (
        _col(parts, "rate_weight_cur")
        + (_col(parts, "rate_weight_prev") - (1 - rho) * _col(parts, "rate_weight_other_prev"))
        + (_col(parts, "rate_weight_prev2") - (1 - rho) * _col(parts, "rate_weight_other_prev2"))
        + prior_minutes
    )
    total = {
        c: _col(parts, f"wsum_{c}")
        - (1 - rho) * _col(parts, f"wsum_other_{c}")
        + _col(parts, "prior_games") * _col(parts, f"prior_{c}_pg")
        for c in PRODUCTION
    }

    def with_prior(wsum: str, weight: str, prior: str, extra: float = 0.0) -> np.ndarray:
        p = _col(parts, prior)
        has = ~np.isnan(p)
        num = _col(parts, wsum) + prior_minutes * np.where(has, p, 0.0)
        den = _col(parts, weight) + np.where(has, prior_minutes, 0.0)
        if extra:
            num = num + extra * _col(parts, "usage_wsum_cur")
            den = den + extra * _col(parts, "usage_weight_cur")
        return _ratio(num, den)

    pace_basis = with_prior("pace_wsum", "pace_weight", "prior_pace")
    target = _col(parts, "pace_target")
    with np.errstate(invalid="ignore", divide="ignore"):
        ok = (np.nan_to_num(target) > 0) & (np.nan_to_num(pace_basis) > 0)
        pace_factor = np.where(
            ok & (beta != 0), np.power(np.where(ok, target / pace_basis, 1.0), beta), 1.0
        )
        usage_basis = with_prior("usage_wsum", "usage_weight", "prior_usage_rate")
        usage_target = with_prior("usage_wsum", "usage_weight", "prior_usage_rate", lam - 1)
        ok = (np.nan_to_num(usage_basis) > 0) & (np.nan_to_num(usage_target) > 0)
        usage_factor = np.where(ok & (lam != 1), np.where(ok, usage_target / usage_basis, 1.0), 1.0)
    minutes = _col(parts, "proj_minutes_pg")
    out: dict[str, np.ndarray] = {}
    for c in PRODUCTION:
        if c in ("fgm", "ftm"):
            continue
        rate = _ratio(total[c], rate_weight) * minutes * pace_factor
        out[c] = rate * usage_factor if c in VOLUME else rate
    for made, tried, key, pct in (
        ("fgm", "fga", "fg_shrink", "league_field_goal_pct"),
        ("ftm", "fta", "ft_shrink", "league_free_throw_pct"),
    ):
        base = _ratio(total[made], rate_weight) * minutes * pace_factor * usage_factor
        k, p = float(s[key]), _col(parts, pct)
        if k == 0:
            out[made] = base
            continue
        shrunk = (
            _ratio(total[tried], rate_weight)
            * minutes
            * pace_factor
            * usage_factor
            * _ratio(total[made] + k * p, total[tried] + k)
        )
        out[made] = np.where(np.isnan(p), base, shrunk)
    return out


def score(line: Mapping[str, np.ndarray], scale: Mapping[str, float]) -> dict[str, np.ndarray]:
    """Each category's value per game above replacement on ``scale`` (an int_value_scale row), as
    macros/value_scale.sql scores it: a missing number scores zero."""

    def z(num: np.ndarray, sd: float) -> np.ndarray:
        if not sd or math.isnan(sd):
            return np.zeros_like(num)
        return np.nan_to_num(num / sd)

    out: dict[str, np.ndarray] = {}
    for c in COUNTING:
        v = z(line[c] - scale[f"mean_{c}"], scale[f"sd_{c}"])
        out[c] = (-v if c == "turnovers" else v) - scale[f"repl_z_{c}"]
    out["field_goal_pct"] = (
        z(line["fgm"] - scale["pool_field_goal_pct"] * line["fga"], scale["sd_fg_impact"])
        - scale["repl_z_field_goal_pct"]
    )
    out["free_throw_pct"] = (
        z(line["ftm"] - scale["pool_free_throw_pct"] * line["fta"], scale["sd_ft_impact"])
        - scale["repl_z_free_throw_pct"]
    )
    return out


def total(scores: Mapping[str, np.ndarray]) -> np.ndarray:
    out: np.ndarray = np.sum([scores[c] for c in CATEGORIES], axis=0)
    return out


SCALE_COLUMNS = (
    *(f"{k}_{c}" for c in COUNTING for k in ("mean", "sd")),
    *(f"repl_z_{c}" for c in CATEGORIES),
    "pool_field_goal_pct",
    "pool_free_throw_pct",
    "sd_fg_impact",
    "sd_ft_impact",
    "pool",
)


def scale_of(df: pd.DataFrame) -> dict[str, float]:
    """The checkpoint's scale, from the ``scale_`` columns every row carries."""
    return {c: float(df[f"scale_{c}"].iloc[0]) for c in SCALE_COLUMNS}


def realized_line(df: pd.DataFrame) -> dict[str, np.ndarray]:
    return {c: np.nan_to_num(_col(df, f"real_{c}_pg")) for c in PRODUCTION}


def check_parity(df: pd.DataFrame, s: Mapping[str, float], where: str) -> None:
    """``lines`` at ``s`` is the mart's line, and ``score`` of it the board's own value."""
    if not len(df):
        return
    want = lines(df, s)
    worst = 0.0
    for c in PRODUCTION:
        got = _col(df, f"proj_{c}_pg")
        worst = max(worst, float(np.nanmax(np.abs(np.nan_to_num(got) - np.nan_to_num(want[c])))))
    own = total(score({c: _col(df, f"proj_{c}_pg") for c in PRODUCTION}, scale_of(df)))
    worst_value = float(np.nanmax(np.abs(own - _col(df, "own_value")))) if len(df) else 0.0
    if worst > 1e-9 or worst_value > 1e-9:
        msg = (
            f"{where}: ops.projection_features differs from mart_player_projection by {worst}"
            f" in the line and {worst_value} in the value"
        )
        raise SystemExit(msg)


@dataclass
class Cut:
    """One checkpoint's judged players, their realized value and the setting values cached."""

    season: str
    checkpoint: float
    parts: pd.DataFrame
    scale: dict[str, float]
    real: np.ndarray
    pool: int
    cache: dict[tuple[float, ...], np.ndarray] = field(default_factory=dict)

    def value(self, s: Mapping[str, float]) -> np.ndarray:
        key = tuple(float(s[k]) for k in NEUTRAL)
        if key not in self.cache:
            self.cache[key] = total(score(lines(self.parts, s), self.scale))
        return self.cache[key]


def load(paths: Iterable[Path], league: str, min_games: int) -> list[Cut]:
    """The checkpoints in the files for ``league``, over the players who then played enough."""
    df = pd.concat([pd.read_csv(p, dtype={"season": str, "player_id": str}) for p in paths])
    df = df[df["league"] == league]
    if "build" in df:
        # a judged run also writes its on build's rows; the features are scored on the off build's
        df = df[df["build"] == "off"]
    if LOCKED[league] in set(df["season"]):
        msg = f"{league} {LOCKED[league]} is held out (#751): it is judged once, at the end"
        raise SystemExit(msg)
    cuts = []
    for (season, cp), g in df.groupby(["season", "checkpoint"], sort=True):
        scale = scale_of(g)
        # players in id order, so the bootstrap draws the same players whatever order a run wrote
        q = g[g["realized_games"] >= min_games].sort_values("player_id").reset_index(drop=True)
        real = total(score(realized_line(q), scale))
        cuts.append(Cut(str(season), float(cp), q, scale, real, int(scale["pool"])))
    return cuts


def _rmse(e: np.ndarray) -> float:
    return float(np.sqrt(np.mean(e**2))) if len(e) else math.nan


def pooled_rmse(cuts: Sequence[Cut], s: Mapping[str, float]) -> float:
    sq = np.concatenate([(c.value(s) - c.real) ** 2 for c in cuts])
    return float(np.sqrt(np.mean(sq)))


def best_point(
    cuts: Sequence[Cut], base: Mapping[str, float], f: Feature
) -> tuple[dict[str, float], float]:
    """The grid point of ``f`` with the lowest pooled RMSE given ``base``; ties go to neutral,
    then the earlier point."""
    neutral = tuple(NEUTRAL[k] for k in f.keys)
    ranked = [
        (
            round(pooled_rmse(cuts, {**base, **dict(zip(f.keys, point, strict=True))}), 12),
            point != neutral,
            i,
            point,
        )
        for i, point in enumerate(f.grid)
    ]
    r, _, _, point = min(ranked)
    return dict(zip(f.keys, point, strict=True)), r


def is_neutral(point: Mapping[str, float]) -> bool:
    return all(float(v) == NEUTRAL[k] for k, v in point.items())


@dataclass(frozen=True)
class Step:
    feature: str
    point: dict[str, float]
    rmse_before: float
    rmse_after: float


def forward_order(cuts: Sequence[Cut]) -> list[Step]:
    """Forward selection on the tuning checkpoints; the features it never chooses follow, in the
    declared order, at their neutral point."""
    base, remaining, steps = dict(NEUTRAL), list(FEATURES), []
    current = pooled_rmse(cuts, base)
    while remaining:
        fits = [(f, *best_point(cuts, base, f)) for f in remaining]
        f, point, r = min(fits, key=lambda t: (t[2], FEATURES.index(t[0])))
        if is_neutral(point) or not r < current:
            break
        steps.append(Step(f.name, point, current, r))
        base, current = {**base, **point}, r
        remaining.remove(f)
    steps.extend(Step(f.name, {k: NEUTRAL[k] for k in f.keys}, current, current) for f in remaining)
    return steps


@dataclass(frozen=True)
class Gap:
    """On minus off at one checkpoint, or pooled over all of them, with 95% intervals."""

    as_of: str
    players: int
    moved: int
    rmse_off: float
    rmse_on: float
    rmse_gap: float
    rmse_low: float
    rmse_high: float
    spearman_off: float
    spearman_on: float
    spearman_gap: float
    spearman_low: float
    spearman_high: float
    top_pool_off: float
    top_pool_on: float
    top_pool_gap: float
    top_pool_low: float
    top_pool_high: float


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    from ops.walk_forward import _spearman as sp

    return sp(a, b)


def _top(a: np.ndarray, b: np.ndarray, pool: int) -> float:
    from ops.walk_forward import _top_share

    return _top_share(a, b, pool)


def compare(
    cuts: Sequence[Cut],
    off: Mapping[str, float] | Sequence[np.ndarray],
    on: Mapping[str, float] | Sequence[np.ndarray],
    *,
    resamples: int,
    seed: int = 0,
    real_on: Sequence[np.ndarray] | None = None,
) -> tuple[list[Gap], Gap]:
    """Each checkpoint's and the pooled gap of ``on`` minus ``off`` (feature settings, or one
    array of values per checkpoint), players resampled within each checkpoint. ``real_on``
    scores ``on`` against other realized values (the same players on another scale)."""

    def values(x: Any, i: int, c: Cut) -> np.ndarray:
        return c.value(x) if isinstance(x, Mapping) else np.asarray(x[i], dtype=float)

    a = [values(off, i, c) for i, c in enumerate(cuts)]
    b = [values(on, i, c) for i, c in enumerate(cuts)]
    rb = [c.real if real_on is None else np.asarray(real_on[i]) for i, c in enumerate(cuts)]
    rng = np.random.default_rng(seed)

    def figures(i: int, idx: np.ndarray) -> tuple[float, float, float, float, float, float]:
        c = cuts[i]
        r, r2 = c.real[idx], rb[i][idx]
        ea, eb = a[i][idx] - r, b[i][idx] - r2
        return (
            float(np.sum(ea**2)),
            float(np.sum(eb**2)),
            _spearman(a[i][idx], r),
            _spearman(b[i][idx], r2),
            _top(a[i][idx], r, c.pool),
            _top(b[i][idx], r2, c.pool),
        )

    n = [len(c.real) for c in cuts]
    point = [figures(i, np.arange(n[i])) for i in range(len(cuts))]
    draws = np.array(
        [
            [figures(i, rng.integers(0, n[i], n[i])) for i in range(len(cuts))]
            for _ in range(resamples)
        ]
    )  # resample x checkpoint x figure

    def gaps(f: np.ndarray, count: int) -> tuple[Any, Any, Any]:
        # f: [..., 6] -> rmse gap, spearman gap, top gap
        rmse_gap = np.sqrt(f[..., 1] / count) - np.sqrt(f[..., 0] / count)
        return rmse_gap, f[..., 3] - f[..., 2], f[..., 5] - f[..., 4]

    out: list[Gap] = []
    for i, c in enumerate(cuts):
        p = np.array(point[i])
        lo = np.percentile(np.array(gaps(draws[:, i, :], n[i])).T, 2.5, axis=0)
        hi = np.percentile(np.array(gaps(draws[:, i, :], n[i])).T, 97.5, axis=0)
        g = gaps(p, n[i])
        out.append(
            Gap(
                as_of=f"{c.season} @ {c.checkpoint:g}",
                players=n[i],
                moved=int(np.sum(np.abs(a[i] - b[i]) > 1e-12)),
                rmse_off=math.sqrt(p[0] / n[i]),
                rmse_on=math.sqrt(p[1] / n[i]),
                rmse_gap=float(g[0]),
                rmse_low=float(lo[0]),
                rmse_high=float(hi[0]),
                spearman_off=float(p[2]),
                spearman_on=float(p[3]),
                spearman_gap=float(g[1]),
                spearman_low=float(lo[1]),
                spearman_high=float(hi[1]),
                top_pool_off=float(p[4]),
                top_pool_on=float(p[5]),
                top_pool_gap=float(g[2]),
                top_pool_low=float(lo[2]),
                top_pool_high=float(hi[2]),
            )
        )
    total_n = sum(n)
    sums = np.array(point).sum(axis=0)
    means = np.array(point).mean(axis=0)
    d_sum = draws.sum(axis=1)
    d_mean = draws.mean(axis=1)
    pooled_draws = np.column_stack(
        [
            np.sqrt(d_sum[:, 1] / total_n) - np.sqrt(d_sum[:, 0] / total_n),
            d_mean[:, 3] - d_mean[:, 2],
            d_mean[:, 5] - d_mean[:, 4],
        ]
    )
    lo, hi = np.percentile(pooled_draws, [2.5, 97.5], axis=0)
    pooled = Gap(
        as_of="pooled",
        players=total_n,
        moved=sum(g.moved for g in out),
        rmse_off=math.sqrt(sums[0] / total_n),
        rmse_on=math.sqrt(sums[1] / total_n),
        rmse_gap=math.sqrt(sums[1] / total_n) - math.sqrt(sums[0] / total_n),
        rmse_low=float(lo[0]),
        rmse_high=float(hi[0]),
        spearman_off=float(means[2]),
        spearman_on=float(means[3]),
        spearman_gap=float(means[3] - means[2]),
        spearman_low=float(lo[1]),
        spearman_high=float(hi[1]),
        top_pool_off=float(means[4]),
        top_pool_on=float(means[5]),
        top_pool_gap=float(means[5] - means[4]),
        top_pool_low=float(lo[2]),
        top_pool_high=float(hi[2]),
    )
    return out, pooled


def passes(per: Sequence[Gap], pooled: Gap) -> tuple[bool, list[str]]:
    """The declared bar; the reasons it is missed, if any."""
    why = []
    if not (pooled.rmse_gap < 0 and pooled.rmse_high < 0):
        why.append(
            f"pooled RMSE {pooled.rmse_gap:+.4f} ({pooled.rmse_low:+.4f} to"
            f" {pooled.rmse_high:+.4f}) is not below zero"
        )
    worse = [g for g in per if g.rmse_gap > TOLERANCE]
    if worse:
        why.append(
            "RMSE rises past the tolerance at "
            + ", ".join(f"{g.as_of} ({g.rmse_gap:+.4f})" for g in worse)
        )
    if pooled.spearman_high < 0:
        why.append(
            f"pooled Spearman falls ({pooled.spearman_low:+.4f} to {pooled.spearman_high:+.4f})"
        )
    return not why, why


@dataclass(frozen=True)
class Judged:
    feature: str
    point: dict[str, float]
    entered: bool
    reasons: list[str]
    tuning_rmse_off: float
    tuning_rmse_on: float
    checkpoints: list[Gap]
    pooled: Gap | None


def judge(
    tuning: Sequence[Cut], judged: Sequence[Cut], *, resamples: int
) -> tuple[list[Step], list[Judged], dict[str, float]]:
    """The declared procedure: the order from the tuning seasons, then each feature in turn."""
    order = forward_order(tuning)
    accepted = dict(NEUTRAL)
    out: list[Judged] = []
    for step in order:
        f = next(x for x in FEATURES if x.name == step.feature)
        point, r_on = best_point(tuning, accepted, f)
        r_off = pooled_rmse(tuning, accepted)
        if is_neutral(point):
            out.append(
                Judged(
                    f.name, point, False, ["no gain on the tuning seasons"], r_off, r_on, [], None
                )
            )
            continue
        on = {**accepted, **point}
        per, pooled = compare(judged, accepted, on, resamples=resamples)
        ok, why = passes(per, pooled)
        out.append(Judged(f.name, point, ok, why, r_off, r_on, per, pooled))
        if ok:
            accepted = on
    return order, out, accepted


def fmt_gap(g: Gap) -> str:
    return (
        f"{g.as_of:>16} {g.players:>5} {g.moved:>5}  RMSE {g.rmse_off:.3f}->{g.rmse_on:.3f}"
        f" {g.rmse_gap:+.4f} ({g.rmse_low:+.4f} to {g.rmse_high:+.4f})"
        f"  Spearman {g.spearman_gap:+.4f} ({g.spearman_low:+.4f} to {g.spearman_high:+.4f})"
        f"  top pool {g.top_pool_gap:+.3f} ({g.top_pool_low:+.3f} to {g.top_pool_high:+.3f})"
    )


def report(
    league: str, order: Sequence[Step], judged: Sequence[Judged], accepted: Mapping[str, float]
) -> str:
    rows = [f"== {league}: forward selection on the tuning seasons {', '.join(TUNING[league])}"]
    rows += [
        f"  {i + 1}. {s.feature} at {s.point}: pooled tuning RMSE"
        f" {s.rmse_before:.4f} -> {s.rmse_after:.4f}"
        for i, s in enumerate(order)
    ]
    rows.append(f"== {league}: judged on {', '.join(JUDGED[league])}")
    for j in judged:
        verdict = "ENTERS" if j.entered else "does not enter"
        rows.append(
            f"-- {j.feature} at {j.point} (tuning RMSE {j.tuning_rmse_off:.4f} ->"
            f" {j.tuning_rmse_on:.4f}): {verdict}"
            + (f": {'; '.join(j.reasons)}" if j.reasons else "")
        )
        rows += [f"   {fmt_gap(g)}" for g in j.checkpoints]
        if j.pooled is not None:
            rows.append(f"   {fmt_gap(j.pooled)}")
    rows.append(f"== {league}: setting {dict(accepted)}")
    return "\n".join(rows)


MEASURES = {
    "declared": "declared: Python on the off build's scale",
    "built_off_scale": "as built (dbt's line) scored on the off build's scale",
    "built_own_scale": "as built, own value, each build on its own scale",
    "built_board": "as built, the board's value (market prior where on), each on its own scale",
}


def confirm(
    paths: Iterable[Path],
    league: str,
    setting: Mapping[str, float],
    min_games: int,
    resamples: int,
) -> dict[str, Any]:
    """A judged run's off and on builds (#771): the declared measure, dbt's on line on the off
    build's scale (which must reproduce it), and the board as built on each build's own scale."""
    df = pd.concat([pd.read_csv(p, dtype={"season": str, "player_id": str}) for p in paths])
    df = df[df["league"] == league]
    cuts: list[Cut] = []
    arrays: dict[str, list[np.ndarray]] = {k: [] for k in ("off", "declared", "sql", "own_off")}
    arrays |= {"own_on": [], "real_on": [], "board_off": [], "board_on": []}
    scales: list[dict[str, Any]] = []
    for (season, cp), g in df.groupby(["season", "checkpoint"], sort=True):
        off = g[(g["build"] == "off") & (g["realized_games"] >= min_games)]
        off = off.sort_values("player_id").reset_index(drop=True)
        on = off[["player_id"]].merge(g[g["build"] == "on"], on="player_id", how="left")
        scale, scale_on = scale_of(off), scale_of(on)
        cut = Cut(str(season), float(cp), off, scale, total(score(realized_line(off), scale)), 0)
        cut.pool = int(scale["pool"])
        cuts.append(cut)
        arrays["off"].append(cut.value(NEUTRAL))
        arrays["declared"].append(cut.value(setting))
        arrays["sql"].append(total(score({c: _col(on, f"proj_{c}_pg") for c in PRODUCTION}, scale)))
        arrays["own_off"].append(_col(off, "own_value"))
        arrays["own_on"].append(_col(on, "own_value"))
        arrays["real_on"].append(total(score(realized_line(on), scale_on)))
        arrays["board_off"].append(_col(off, "board_value"))
        arrays["board_on"].append(_col(on, "board_value"))
        scales.append(
            {"as_of": f"{season} @ {cp:g}"}
            | {k: scale_on[k] / scale[k] for k in ("sd_points", "sd_fg_impact", "sd_ft_impact")}
        )
    worst = max(
        float(np.max(np.abs(a - b))) for a, b in zip(arrays["sql"], arrays["declared"], strict=True)
    )
    return {
        "declared": compare(cuts, arrays["off"], arrays["declared"], resamples=resamples),
        "built_off_scale": compare(cuts, arrays["off"], arrays["sql"], resamples=resamples),
        "built_own_scale": compare(
            cuts,
            arrays["own_off"],
            arrays["own_on"],
            resamples=resamples,
            real_on=arrays["real_on"],
        ),
        "built_board": compare(
            cuts,
            arrays["board_off"],
            arrays["board_on"],
            resamples=resamples,
            real_on=arrays["real_on"],
        ),
        "parity": {"worst_value_gap": worst, "scale_on_over_off": scales},
    }


def _gaps_doc(v: tuple[list[Gap], Gap]) -> dict[str, Any]:
    return {"checkpoints": [asdict(g) for g in v[0]], "pooled": asdict(v[1])}


def confirm_report(league: str, setting: Mapping[str, float], found: Mapping[str, Any]) -> str:
    rows = [f"== {league}: the board off and on {dict(setting)}"]
    for key, label in MEASURES.items():
        per, pooled = found[key]
        rows.append(f"-- {label}")
        rows += [f"   {fmt_gap(g)}" for g in [*per, pooled]]
    par = found["parity"]
    rows.append(
        "-- dbt's on value minus the declared one, on the off scale: at most"
        f" {par['worst_value_gap']:.2e}"
    )
    rows += [
        "   "
        + s["as_of"]
        + ": on/off spread "
        + ", ".join(f"{k} {v:.3f}" for k, v in s.items() if k != "as_of")
        for s in par["scale_on_over_off"]
    ]
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge", help="fit on the tuning seasons, judge on the judged ones")
    j.add_argument("--league", choices=("nba", "wnba"), required=True)
    j.add_argument("files", type=Path, nargs="+", help="ops.walk_forward --features-out")
    j.add_argument("--out", type=Path)
    c = sub.add_parser("confirm", help="the board as built off and on, on both scales")
    c.add_argument("--league", choices=("nba", "wnba"), required=True)
    c.add_argument("--setting", required=True, help="the features judged, as JSON")
    c.add_argument("files", type=Path, nargs="+", help="a --features run's --features-out")
    c.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = {x["id"]: x["value"] for x in parameters.load()}
    min_games, resamples = int(p["backtest.min_games"]), int(p["backtest.bootstrap"])
    if args.cmd == "confirm":
        setting = {**NEUTRAL, **json.loads(args.setting)}
        found = confirm(args.files, args.league, setting, min_games, resamples)
        print(confirm_report(args.league, setting, found))
        if args.out is not None:
            doc = {k: v if k == "parity" else _gaps_doc(v) for k, v in found.items()}
            args.out.write_text(json.dumps(doc, indent=2, default=str) + "\n", encoding="utf-8")
        return 0
    cuts = load(args.files, args.league, min_games)
    tuning = [c for c in cuts if c.season in TUNING[args.league]]
    judged_cuts = [c for c in cuts if c.season in JUDGED[args.league]]
    missing = (set(TUNING[args.league]) | set(JUDGED[args.league])) - {c.season for c in cuts}
    if missing:
        print(f"missing seasons: {sorted(missing)}", file=sys.stderr)
        return 2
    order, judged, accepted = judge(tuning, judged_cuts, resamples=resamples)
    print(report(args.league, order, judged, accepted))
    if args.out is not None:
        doc = {
            "league": args.league,
            "order": [asdict(s) for s in order],
            "judged": [asdict(x) for x in judged],
            "setting": accepted,
        }
        args.out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
