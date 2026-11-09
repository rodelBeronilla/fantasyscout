"""What the NBA ML challenger learns, and how much of it a transparent term carries (#916).

    uv run --group benchmark python -m ops.challenger_analysis --setting features-nba.json \
        features-nba-*.csv --out challenger-analysis.json

ops.projection_challenger's stacked model (one gradient-boosted model per category, on the raw
inputs and the transparent model's nine category scores) beats the transparent NBA projection
out of sample (ADR 0030). This reads the same walk-forward exports and asks why:

- **Where the gain is.** Each tuning season's challenger values come from a model fitted on the
  other two (leave one season out, the folds its grid was chosen on). The squared-error reduction
  is split by segment, and the importance of each input is measured by permutation on the
  held-out season (sklearn's ``permutation_importance``, and the inputs permuted in groups),
  with partial dependence for the inputs that matter.
- **Transparent terms.** Each candidate is a published coefficient on the transparent value. Its
  coefficient is fitted on two tuning seasons and scored on the third, rotated, so it is scored
  in the challenger's own folds. That is cross-validation within the tuning seasons: indicative
  only. A term enters the projection only once judged on a season neither has seen.
- **The judged seasons, read only.** The challenger as declared (fitted on all three tuning
  seasons) and the terms at their tuning coefficients are scored on NBA 2023-24 and 2024-25. Those
  seasons are spent for the projection's features, so this is a diagnosis, not a judgement.
  The locked season is refused, as everywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from itertools import product
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import parameters
from ops import projection_challenger as pc
from ops import projection_features as pf

# the stacked variant's grid point, chosen by ops.projection_challenger's leave-one-season-out
# cross-validation on NBA 2020-21 to 2022-23 (CV RMSE 2.1233, as published in ADR 0030)
CHOSEN: dict[str, float] = {
    "learning_rate": 0.05,
    "max_leaf_nodes": 15,
    "min_samples_leaf": 20,
    "max_iter": 100,
    "l2_regularization": 1.0,
}
# in season, a player with fewer games than this this season is "short of games": the same gate
# below which the projection ignores his last games' minutes and his return from an absence
SHORT_GAMES = 5
USAGE_PIVOT = 0.20
GROUPS: dict[str, list[str]] = {
    "transparent scores": [f"transparent_{c}" for c in pf.CATEGORIES],
    "minutes": [
        "proj_minutes_pg",
        "proj_minutes_season_pg",
        "minutes_last5_pg",
        "s1_minutes_pg",
        "s2_minutes_pg",
        "s3_minutes_pg",
    ],
    "games played": ["s1_games", "s2_games", "s3_games"],
    "this season's rates (s1)": [f"s1_{c}_pm" for c in pf.PRODUCTION],
    "earlier seasons' rates (s2, s3)": [f"s{k}_{c}_pm" for k in (2, 3) for c in pf.PRODUCTION],
    "availability": ["games_share", "absence_games", "games_since_return"],
    "usage and pace": ["usage_basis", "usage_current", "pace_basis", "pace_target"],
    "new team": ["is_new_team"],
}
PD_FEATURES = ("s1_games", "s1_minutes_pg", "minutes_last5_pg", "games_share", "usage_basis")


def short_of_games(cut: pf.Cut) -> np.ndarray:
    if cut.checkpoint == 0:
        return np.zeros(len(cut.parts), dtype=bool)
    out: np.ndarray = np.nan_to_num(cut.parts["games_current"].to_numpy(float)) < SHORT_GAMES
    return out


def usage(cut: pf.Cut) -> np.ndarray:
    """The production-weighted usage rate; the pivot (no tilt) where there is none."""
    w = cut.parts["usage_weight"].to_numpy(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        u = np.where(w > 0, cut.parts["usage_wsum"].to_numpy(float) / w, np.nan)
    out: np.ndarray = np.nan_to_num(u, nan=USAGE_PIVOT)
    return out


def minutes(cut: pf.Cut, early: float = 0.0, prior: float = 1.0) -> np.ndarray:
    """Projected minutes with ``early``: before five games this season, the last games' minutes
    enter at fantasy_recent_minutes (0.5) x games / 5 x ``early``; and ``prior``: the minutes
    prior's minutes (a replacement-level player's) scaled by it. At (0, 1), the cut's minutes."""
    p = cut.parts
    season = p["proj_minutes_season_pg"].to_numpy(float)
    last = p["minutes_last5_pg"].to_numpy(float)
    ramp = p["return_minutes_factor"].to_numpy(float)
    games = np.nan_to_num(p["games_current"].to_numpy(float))
    has = ~np.isnan(last)
    blended = has & np.isclose(
        p["proj_minutes_pg"].to_numpy(float), (0.5 * season + 0.5 * np.nan_to_num(last)) * ramp
    )
    if prior != 1.0:
        season = (
            p["minutes_weighted"].to_numpy(float) + prior * p["prior_minutes"].to_numpy(float)
        ) / (p["minutes_games_weight"].to_numpy(float) + p["prior_games"].to_numpy(float))
    w = np.where(blended, 0.5, 0.0)
    if early and cut.checkpoint > 0:
        soon = has & ~blended & (games < SHORT_GAMES)
        w = np.where(soon, np.minimum(1.0, 0.5 * early * np.minimum(games, 5) / 5), w)
    out: np.ndarray = ((1 - w) * season + w * np.nan_to_num(last)) * ramp
    return out


Cache = dict[tuple[int, tuple[tuple[str, float], ...]], np.ndarray]


def term_value(
    cut: pf.Cut, setting: Mapping[str, float], k: Mapping[str, float], cache: Cache | None = None
) -> np.ndarray:
    """The transparent value with the candidate terms at ``k`` (each neutral when absent):
    ``short`` per game off a player short of games, ``usage`` per 0.10 of usage above the pivot,
    and ``early`` and ``prior`` in his minutes (``minutes``)."""
    key = (id(cut), tuple(sorted((a, float(b)) for a, b in k.items())))
    if cache is not None and key in cache:
        return cache[key]
    early, prior = float(k.get("early", 0.0)), float(k.get("prior", 1.0))
    if early or prior != 1.0:
        parts = cut.parts.copy()
        parts["proj_minutes_pg"] = minutes(cut, early, prior)
        v = pf.total(pf.score(pf.lines(parts, setting), cut.scale))
    else:
        v = cut.value(setting).copy()
    v = v - float(k.get("short", 0.0)) * short_of_games(cut)
    v = v + float(k.get("usage", 0.0)) * (usage(cut) - USAGE_PIVOT) * 10
    if cache is not None:
        cache[key] = v
    return v


SHORTS = tuple(float(round(b, 2)) for b in np.arange(0, 2.01, 0.1))
USAGES = tuple(float(round(u, 2)) for u in np.arange(0, 1.51, 0.1))
TERMS: dict[str, list[dict[str, float]]] = {
    "short of games: value - b": [{"short": b} for b in SHORTS],
    "usage: value + u per 0.10 above 0.20": [{"usage": u} for u in USAGES],
    "both": [{"short": b, "usage": u} for b, u in product(SHORTS, USAGES)],
    "short of games in minutes: early minutes, prior minutes x f": [
        {"early": e, "prior": f}
        for e, f in product((0.0, 0.5, 1.0, 1.5, 2.0, 3.0), (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4))
    ],
}


def fit_models(x: pd.DataFrame, y: Mapping[str, np.ndarray]) -> Any:
    """The stacked challenger as one estimator whose prediction is the value (sklearn API)."""
    from sklearn.base import BaseEstimator, RegressorMixin
    from sklearn.ensemble import HistGradientBoostingRegressor

    class Stacked(RegressorMixin, BaseEstimator):  # type: ignore[misc]
        def fit(self, x: pd.DataFrame, y: Mapping[str, np.ndarray]) -> Stacked:
            self.keep_ = [c for c in x.columns if x[c].notna().any()]
            self.models_ = {
                c: HistGradientBoostingRegressor(
                    loss="squared_error", random_state=0, early_stopping=False, **CHOSEN
                ).fit(x[self.keep_], y[c])
                for c in pf.CATEGORIES
            }
            return self

        def predict(self, x: pd.DataFrame) -> np.ndarray:
            out: np.ndarray = np.sum([m.predict(x[self.keep_]) for m in self.models_.values()], 0)
            return out

    return Stacked().fit(x, y)


@dataclass(frozen=True)
class TermResult:
    name: str
    per_fold: dict[str, dict[str, float]]
    tuning_point: dict[str, float]
    gap: float
    low: float
    high: float
    spearman: float
    spearman_low: float
    spearman_high: float
    share_of_gain: float
    share_of_spearman: float
    pool_gap: float
    judged_gap: float
    judged_share: float
    judged_pool_gap: float


def pool_rows(cuts: Sequence[pf.Cut], base: Sequence[np.ndarray]) -> list[np.ndarray]:
    """Each checkpoint's players in its pool by the transparent value: the rosterable ones."""
    return [np.argsort(-b, kind="stable")[: c.pool] for c, b in zip(cuts, base, strict=True)]


def rmse(
    cuts: Sequence[pf.Cut], preds: Sequence[np.ndarray], rows: Sequence[Any] | None = None
) -> float:
    rows = rows if rows is not None else [slice(None)] * len(cuts)
    sq = [(p[r] - c.real[r]) ** 2 for c, p, r in zip(cuts, preds, rows, strict=True)]
    return float(np.sqrt(np.mean(np.concatenate(sq))))


def loso(
    cuts: Sequence[pf.Cut], grid: Sequence[Mapping[str, float]], value: Callable[..., np.ndarray]
) -> tuple[list[np.ndarray], dict[str, dict[str, float]]]:
    """Each season's values at the grid point best on the other tuning seasons."""
    preds: list[np.ndarray] = [np.empty(0)] * len(cuts)
    chosen = {}
    for s in sorted({c.season for c in cuts}):
        train = [c for c in cuts if c.season != s]
        k = min(
            grid, key=lambda g: (round(rmse(train, [value(c, g) for c in train]), 12), *g.values())
        )
        chosen[s] = dict(k)
        for i, c in enumerate(cuts):
            if c.season == s:
                preds[i] = value(c, k)
    return preds, chosen


def segments(
    cuts: Sequence[pf.Cut], base: Sequence[np.ndarray], chal: Sequence[np.ndarray]
) -> dict[str, dict[str, float]]:
    """Each segment's share of players and of the challenger's squared-error reduction."""
    red = np.concatenate(
        [(b - c.real) ** 2 - (h - c.real) ** 2 for c, b, h in zip(cuts, base, chal, strict=True)]
    )
    resid = np.concatenate([c.real - b for c, b in zip(cuts, base, strict=True)])
    move = np.concatenate([h - b for b, h in zip(base, chal, strict=True)])
    pre = np.concatenate([np.full(len(c.real), c.checkpoint == 0) for c in cuts])
    short = np.concatenate([short_of_games(c) for c in cuts])
    few = np.concatenate([np.nan_to_num(c.parts["s1_games"].to_numpy(float)) < 40 for c in cuts])
    pooled = np.zeros(len(red), dtype=bool)
    at = 0
    for c, r in zip(cuts, pool_rows(cuts, base), strict=True):
        pooled[at + r] = True
        at += len(c.real)
    masks = {
        "in season, short of games": short,
        "in season, the rest": ~pre & ~short,
        "preseason, under 40 games last season": pre & few,
        "preseason, the rest": pre & ~few,
        "in the pool by the transparent value": pooled,
    }
    return {
        k: {
            "players": float(m.mean()),
            "share_of_reduction": float(red[m].sum() / red.sum()),
            "mean_residual": float(resid[m].mean()) if m.any() else 0.0,
            "mean_move": float(move[m].mean()) if m.any() else 0.0,
        }
        for k, m in masks.items()
    }


MOVER_COLUMNS = (
    "games_current",
    "s1_minutes_pg",
    "minutes_last5_pg",
    "proj_minutes_pg",
    "games_share",
)


def movers(
    cuts: Sequence[pf.Cut], base: Sequence[np.ndarray], chal: Sequence[np.ndarray], top: int = 50
) -> list[dict[str, Any]]:
    """At each tenth-of-the-season checkpoint, whom the challenger moves most, and does it help."""
    out = []
    for c, b, h in zip(cuts, base, chal, strict=True):
        if c.checkpoint != 0.1:
            continue
        move, short = h - b, short_of_games(c)
        red = (b - c.real) ** 2 - (h - c.real) ** 2
        idx = np.argsort(-np.abs(move), kind="stable")[:top]
        rows = c.parts.iloc[idx[:8]][list(MOVER_COLUMNS)].assign(
            transparent=b[idx[:8]], challenger=h[idx[:8]], realized=c.real[idx[:8]]
        )
        out.append(
            {
                "as_of": f"{c.season} @ {c.checkpoint:g}",
                "top": top,
                "short_of_games": float(short[idx].mean()),
                "moved_down": float((move[idx] < 0).mean()),
                "closer": float((red[idx] > 0).mean()),
                "share_of_reduction": float(red[idx].sum() / red.sum()),
                "short_players": float(short.mean()),
                "short_share_of_reduction": float(red[short].sum() / red.sum()),
                "examples": rows.round(2).to_dict(orient="records"),
            }
        )
    return out


def importance(
    d: pc.Data, folds: Mapping[str, Any], repeats: int = 5
) -> tuple[dict[str, float], dict[str, float], dict[str, dict[str, list[float]]]]:
    """Value-level permutation importance per input and per group (MSE increase, pooled over the
    held-out checkpoints), and partial dependence averaged over the folds."""
    from sklearn.inspection import partial_dependence, permutation_importance

    rng = np.random.default_rng(0)
    one: dict[str, float] = {}
    grp: dict[str, float] = {}
    n = sum(len(c.real) for c in d.cuts)
    for i, c in enumerate(d.cuts):
        m, x = folds[c.season], d.x["stacked"][i]
        r = permutation_importance(
            m, x, c.real, scoring="neg_mean_squared_error", n_repeats=repeats, random_state=0
        )
        for f, v in zip(x.columns, r.importances_mean, strict=True):
            one[f] = one.get(f, 0.0) + float(v) * len(x) / n
        base = float(np.mean((m.predict(x) - c.real) ** 2))
        for g, cols in GROUPS.items():
            ups = []
            for _ in range(repeats):
                xp = x.copy()
                xp[cols] = x[cols].to_numpy()[rng.permutation(len(x))]
                ups.append(float(np.mean((m.predict(xp) - c.real) ** 2)) - base)
            grp[g] = grp.get(g, 0.0) + float(np.mean(ups)) * len(x) / n
    pdp: dict[str, dict[str, list[float]]] = {}
    for f in PD_FEATURES:
        allx = pd.concat(d.x["stacked"], ignore_index=True)[f].to_numpy(float)
        grid = np.unique(np.nanpercentile(allx, np.linspace(2, 98, 15)))
        curves = []
        for s, m in folds.items():
            x = pd.concat([d.x["stacked"][i] for i, c in enumerate(d.cuts) if c.season == s])
            curves.append(
                partial_dependence(m, x, [f], kind="average", custom_values={f: grid})["average"][0]
            )
        avg = np.mean(curves, axis=0)
        pdp[f] = {"grid": grid.tolist(), "value": (avg - avg.max()).tolist()}
    return dict(sorted(one.items(), key=lambda t: -t[1])), grp, pdp


def analyse(
    tuning: Sequence[pf.Cut],
    judged: Sequence[pf.Cut],
    setting: Mapping[str, float],
    *,
    resamples: int,
    terms: Mapping[str, Sequence[Mapping[str, float]]] = TERMS,
    repeats: int = 5,
) -> dict[str, Any]:
    t, j = pc.prepare(tuning, setting), pc.prepare(judged, setting)
    seasons = sorted({c.season for c in tuning})
    folds = {}
    chal: list[np.ndarray] = [np.empty(0)] * len(tuning)
    for s in seasons:
        folds[s] = fit_models(
            *pc._stack(t, "stacked", [i for i, c in enumerate(tuning) if c.season != s])
        )
        for i, c in enumerate(tuning):
            if c.season == s:
                chal[i] = folds[s].predict(t.x["stacked"][i])
    full = fit_models(*pc._stack(t, "stacked", range(len(tuning))))
    jchal = [full.predict(x) for x in j.x["stacked"]]
    jrows = pool_rows(judged, j.transparent)
    per_c, pooled_c = pf.compare(tuning, t.transparent, chal, resamples=resamples)
    _, jpooled_c = pf.compare(judged, j.transparent, jchal, resamples=resamples)
    rows = pool_rows(tuning, t.transparent)
    pool_base = rmse(tuning, t.transparent, rows)
    results = []
    cache: Cache = {}

    def value(c: pf.Cut, k: Mapping[str, float]) -> np.ndarray:
        return term_value(c, setting, k, cache)

    for name, grid in terms.items():
        preds, chosen = loso(tuning, grid, value)
        _, pooled = pf.compare(tuning, t.transparent, preds, resamples=resamples)
        point = min(
            grid,
            key=lambda g: (round(rmse(tuning, [value(c, g) for c in tuning]), 12), *g.values()),
        )
        jgap = rmse(judged, [value(c, point) for c in judged]) - jpooled_c.rmse_off
        jpool = rmse(judged, [value(c, point) for c in judged], jrows) - rmse(
            judged, j.transparent, jrows
        )
        results.append(
            TermResult(
                name,
                chosen,
                dict(point),
                pooled.rmse_gap,
                pooled.rmse_low,
                pooled.rmse_high,
                pooled.spearman_gap,
                pooled.spearman_low,
                pooled.spearman_high,
                pooled.rmse_gap / pooled_c.rmse_gap,
                pooled.spearman_gap / pooled_c.spearman_gap,
                rmse(tuning, preds, rows) - pool_base,
                jgap,
                jgap / jpooled_c.rmse_gap,
                jpool,
            )
        )
    one, grp, pdp = importance(t, folds, repeats)
    return {
        "challenger": {
            "tuning": asdict(pooled_c),
            "tuning_checkpoints": [asdict(g) for g in per_c],
            "tuning_pool_gap": rmse(tuning, chal, rows) - pool_base,
            "judged": asdict(jpooled_c),
            "judged_pool_gap": rmse(judged, jchal, jrows) - rmse(judged, j.transparent, jrows),
        },
        "segments": {
            "tuning": segments(tuning, t.transparent, chal),
            "judged": segments(judged, j.transparent, jchal),
        },
        "movers": movers(tuning, t.transparent, chal) + movers(judged, j.transparent, jchal),
        "terms": [asdict(r) for r in results],
        "importance": {"inputs": one, "groups": grp, "partial_dependence": pdp},
    }


def report(doc: Mapping[str, Any]) -> str:
    c = doc["challenger"]
    tg, jg = c["tuning"], c["judged"]
    rows = [
        "== the stacked challenger, minus the transparent model",
        f"   tuning, leave one season out: RMSE {tg['rmse_off']:.4f} -> {tg['rmse_on']:.4f},"
        f" {tg['rmse_gap']:+.4f} ({tg['rmse_low']:+.4f} to {tg['rmse_high']:+.4f}),"
        f" Spearman {tg['spearman_gap']:+.4f}; in the pool {c['tuning_pool_gap']:+.4f}",
        f"   judged (read only): {jg['rmse_off']:.4f} -> {jg['rmse_on']:.4f},"
        f" {jg['rmse_gap']:+.4f}, Spearman {jg['spearman_gap']:+.4f};"
        f" in the pool {c['judged_pool_gap']:+.4f}",
        "== share of the challenger's squared-error reduction",
    ]
    for fold, segs in doc["segments"].items():
        for k, v in segs.items():
            rows.append(
                f"   {fold:6s} {k:40s} players {v['players']:5.0%}"
                f"  reduction {v['share_of_reduction']:+5.0%}"
                f"  mean residual {v['mean_residual']:+.2f}  mean move {v['mean_move']:+.2f}"
            )
    rows.append("== the players moved most at a tenth of the season (judged seasons read only)")
    for m in doc["movers"]:
        rows.append(
            f"   {m['as_of']:>14}: of the {m['top']} moved most, short of games"
            f" {m['short_of_games']:.0%}, moved down {m['moved_down']:.0%},"
            f" closer {m['closer']:.0%},"
            f" {m['share_of_reduction']:+.0%} of the reduction; short of games are"
            f" {m['short_players']:.0%} of players and {m['short_share_of_reduction']:+.0%} of it"
        )
        rows += [f"      {e}" for e in m["examples"][:3]]
    rows.append("== transparent terms (cross-validated within the tuning seasons; indicative only)")
    for r in doc["terms"]:
        rows.append(
            f"-- {r['name']}: per fold {r['per_fold']}, on all three {r['tuning_point']}\n"
            f"   RMSE {r['gap']:+.4f} ({r['low']:+.4f} to {r['high']:+.4f}),"
            f" {r['share_of_gain']:.0%} of the challenger's;"
            f" Spearman {r['spearman']:+.4f} ({r['spearman_low']:+.4f} to"
            f" {r['spearman_high']:+.4f}), {r['share_of_spearman']:.0%};"
            f" in the pool {r['pool_gap']:+.4f};"
            f" judged (read only) {r['judged_gap']:+.4f}, {r['judged_share']:.0%},"
            f" in the pool {r['judged_pool_gap']:+.4f}"
        )
    imp = doc["importance"]
    rows.append("== permutation importance, value MSE increase (groups, then the top inputs)")
    rows += [f"   {k:32s} {v:.4f}" for k, v in sorted(imp["groups"].items(), key=lambda t: -t[1])]
    rows += [f"   {k:32s} {v:.4f}" for k, v in list(imp["inputs"].items())[:15]]
    rows.append("== partial dependence of the value, relative to its highest point")
    for f, v in imp["partial_dependence"].items():
        rows.append(
            f"   {f}: "
            + " ".join(f"{g:.3g}:{y:+.2f}" for g, y in zip(v["grid"], v["value"], strict=True))
        )
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    os.environ.setdefault("OMP_NUM_THREADS", "1")  # small fits run faster on one thread
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--setting", type=Path, required=True, help="ops.projection_features judge --out"
    )
    parser.add_argument("files", type=Path, nargs="+", help="ops.walk_forward --features-out")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = {x["id"]: x["value"] for x in parameters.load()}
    min_games, resamples = int(p["backtest.min_games"]), int(p["backtest.bootstrap"])
    setting = json.loads(args.setting.read_text(encoding="utf-8"))["setting"]
    cuts = pf.load(args.files, "nba", min_games)
    tuning = [c for c in cuts if c.season in pf.TUNING["nba"]]
    judged = [c for c in cuts if c.season in pf.JUDGED["nba"]]
    doc = analyse(tuning, judged, setting, resamples=resamples)
    print(report(doc))
    if args.out is not None:
        args.out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
