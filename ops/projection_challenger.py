"""A machine-learning challenger to the transparent projection, reported and never gated (#771).

    uv run --group benchmark python -m ops.projection_challenger --league nba \
        --setting features-nba.json features-*.csv --out challenger-nba.json

The transparent projection (mart_player_projection with the features that entered) is the
production model. This runs a gradient-boosted challenger through the same walk-forward
checkpoints (ops.walk_forward ``--features-out``) and reports how it compares. It was declared on
#771 before any run:

- **Model.** scikit-learn's HistGradientBoostingRegressor (squared error, random_state 0, no early
  stopping), one per category, each predicting that category's realized value per game on the
  checkpoint's scale; the value is their sum, so a punt build could still be made from it.
- **Features.** Variant ``raw``: the checkpoint, age, rookie and new team; games, minutes per game
  and the eleven production numbers per minute in each of the three seasons; projected,
  season-weighted and last-five minutes; games share, absence and games since return; usage
  (production-weighted and this season's), expected pace and the pace the rates were made at.
  Variant ``stacked``: those plus the transparent model's nine category scores.
- **Grid.** learning_rate 0.05 or 0.1, max_leaf_nodes 7, 15 or 31, min_samples_leaf 20 or 80,
  max_iter 100 or 300, l2_regularization 0 or 1: the point with the lowest pooled value RMSE in
  leave-one-season-out cross-validation over the tuning seasons, then refitted on all of them.
- **Margin.** It would ship only if, on the judged checkpoints, its pooled RMSE is lower than the
  transparent model's by at least ``MARGIN`` of the transparent model's pooled RMSE, with the
  paired-bootstrap interval's upper bound below zero and no checkpoint worse by more than
  ops.projection_features.TOLERANCE; even then the owner decides, since transparency is a product
  value.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from itertools import product
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import parameters
from ops import projection_features as pf

MARGIN = 0.03
GRID: tuple[dict[str, float], ...] = tuple(
    {
        "learning_rate": lr,
        "max_leaf_nodes": leaves,
        "min_samples_leaf": leaf,
        "max_iter": iters,
        "l2_regularization": l2,
    }
    for lr, leaves, leaf, iters, l2 in product(
        (0.05, 0.1), (7, 15, 31), (20, 80), (100, 300), (0.0, 1.0)
    )
)
VARIANTS = ("raw", "stacked")


def _per_minute(df: pd.DataFrame, k: int, c: str) -> np.ndarray:
    minutes = df[f"s{k}_minutes_pg"].to_numpy(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        out: np.ndarray = np.where(
            minutes > 0, df[f"s{k}_{c}_pg"].to_numpy(float) / minutes, np.nan
        )
    return out


def _ratio(df: pd.DataFrame, num: str, den: str) -> np.ndarray:
    d = df[den].to_numpy(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        out: np.ndarray = np.where(d > 0, df[num].to_numpy(float) / d, np.nan)
    return out


def features(cut: pf.Cut, transparent: Mapping[str, np.ndarray] | None) -> pd.DataFrame:
    """The declared inputs for one checkpoint's players; with ``transparent``, the stacked ones."""
    df = cut.parts
    out: dict[str, Any] = {
        "checkpoint": np.full(len(df), cut.checkpoint),
        "age": df["age"].to_numpy(float),
        "is_rookie": df["is_rookie"].astype(float).to_numpy(),
        "is_new_team": (df["prev_team_id"].notna() & (df["prev_team_id"] != df["team_id"])).astype(
            float
        ),
    }
    for k in (1, 2, 3):
        out[f"s{k}_games"] = df[f"s{k}_games"].to_numpy(float)
        out[f"s{k}_minutes_pg"] = df[f"s{k}_minutes_pg"].to_numpy(float)
        for c in pf.PRODUCTION:
            out[f"s{k}_{c}_pm"] = _per_minute(df, k, c)
    for c in (
        "proj_minutes_pg",
        "proj_minutes_season_pg",
        "minutes_last5_pg",
        "games_share",
        "absence_games",
        "games_since_return",
        "pace_target",
    ):
        out[c] = df[c].to_numpy(float)
    out["usage_basis"] = _ratio(df, "usage_wsum", "usage_weight")
    out["usage_current"] = _ratio(df, "usage_wsum_cur", "usage_weight_cur")
    out["pace_basis"] = _ratio(df, "pace_wsum", "pace_weight")
    if transparent is not None:
        for c in pf.CATEGORIES:
            out[f"transparent_{c}"] = transparent[c]
    return pd.DataFrame(out)


@dataclass
class Data:
    """Every checkpoint's inputs, transparent category scores and realized category scores."""

    cuts: list[pf.Cut]
    x: dict[str, list[pd.DataFrame]]
    transparent: list[np.ndarray]
    targets: list[dict[str, np.ndarray]]


def prepare(cuts: Sequence[pf.Cut], setting: Mapping[str, float]) -> Data:
    x: dict[str, list[pd.DataFrame]] = {v: [] for v in VARIANTS}
    transparent, targets = [], []
    for c in cuts:
        t = pf.score(pf.lines(c.parts, setting), c.scale)
        transparent.append(pf.total(t))
        targets.append(pf.score(pf.realized_line(c.parts), c.scale))
        x["raw"].append(features(c, None))
        x["stacked"].append(features(c, t))
    return Data(list(cuts), x, transparent, targets)


def _fit_predict(
    train_x: pd.DataFrame,
    train_y: Mapping[str, np.ndarray],
    test_x: pd.DataFrame,
    params: Mapping[str, float],
) -> np.ndarray:
    from sklearn.ensemble import HistGradientBoostingRegressor

    # a column with no value in the training rows says nothing (and the binner cannot cut it)
    keep = [c for c in train_x.columns if train_x[c].notna().any()]
    pred = np.zeros(len(test_x))
    for c in pf.CATEGORIES:
        model = HistGradientBoostingRegressor(
            loss="squared_error", random_state=0, early_stopping=False, **params
        )
        model.fit(train_x[keep], train_y[c])
        pred += model.predict(test_x[keep])
    return pred


def _stack(d: Data, variant: str, idx: Sequence[int]) -> tuple[pd.DataFrame, dict[str, np.ndarray]]:
    x = pd.concat([d.x[variant][i] for i in idx], ignore_index=True)
    y = {c: np.concatenate([d.targets[i][c] for i in idx]) for c in pf.CATEGORIES}
    return x, y


def cross_validate(d: Data, variant: str, params: Mapping[str, float]) -> float:
    """Pooled value RMSE, each tuning season predicted by a model fitted on the other two."""
    errors = []
    for season in sorted({c.season for c in d.cuts}):
        test = [i for i, c in enumerate(d.cuts) if c.season == season]
        train = [i for i, c in enumerate(d.cuts) if c.season != season]
        tx, ty = _stack(d, variant, train)
        vx, _ = _stack(d, variant, test)
        pred = _fit_predict(tx, ty, vx, params)
        real = np.concatenate([d.cuts[i].real for i in test])
        errors.append((pred - real) ** 2)
    return float(np.sqrt(np.mean(np.concatenate(errors))))


def ships(per: Sequence[pf.Gap], pooled: pf.Gap) -> tuple[bool, list[str]]:
    """The declared margin; the reasons it is missed, if any."""
    why = []
    if not pooled.rmse_gap <= -MARGIN * pooled.rmse_off:
        why.append(
            f"pooled RMSE {pooled.rmse_gap:+.4f} is not {MARGIN:.0%} of {pooled.rmse_off:.4f} lower"
        )
    if not pooled.rmse_high < 0:
        why.append(f"the interval's upper bound {pooled.rmse_high:+.4f} is not below zero")
    if worse := [g for g in per if g.rmse_gap > pf.TOLERANCE]:
        why.append("worse past the tolerance at " + ", ".join(g.as_of for g in worse))
    return not why, why


@dataclass(frozen=True)
class Result:
    variant: str
    params: dict[str, float]
    cv_rmse: float
    ships: bool
    reasons: list[str]
    checkpoints: list[pf.Gap]
    pooled: pf.Gap


def run(
    tuning: Sequence[pf.Cut],
    judged: Sequence[pf.Cut],
    setting: Mapping[str, float],
    *,
    resamples: int,
    grid: Sequence[Mapping[str, float]] = GRID,
) -> list[Result]:
    t, j = prepare(tuning, setting), prepare(judged, setting)
    out = []
    for variant in VARIANTS:
        scored = [(cross_validate(t, variant, g), i) for i, g in enumerate(grid)]
        cv, best = min(scored)
        params = dict(grid[best])
        tx, ty = _stack(t, variant, range(len(t.cuts)))
        preds = []
        for i in range(len(j.cuts)):
            preds.append(_fit_predict(tx, ty, j.x[variant][i], params))
        per, pooled = pf.compare(j.cuts, j.transparent, preds, resamples=resamples)
        ok, why = ships(per, pooled)
        out.append(Result(variant, params, cv, ok, why, per, pooled))
        print(f"{variant}: grid {params}, CV RMSE {cv:.4f}", file=sys.stderr)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--league", choices=("nba", "wnba"), required=True)
    parser.add_argument(
        "--setting", type=Path, help="ops.projection_features judge --out (default: all off)"
    )
    parser.add_argument("files", type=Path, nargs="+", help="ops.walk_forward --features-out")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = {x["id"]: x["value"] for x in parameters.load()}
    min_games, resamples = int(p["backtest.min_games"]), int(p["backtest.bootstrap"])
    setting = (
        json.loads(args.setting.read_text(encoding="utf-8"))["setting"]
        if args.setting
        else dict(pf.NEUTRAL)
    )
    cuts = pf.load(args.files, args.league, min_games)
    tuning = [c for c in cuts if c.season in pf.TUNING[args.league]]
    judged = [c for c in cuts if c.season in pf.JUDGED[args.league]]
    results = run(tuning, judged, setting, resamples=resamples)
    for r in results:
        verdict = "would ship" if r.ships else "does not ship"
        print(f"== {args.league} challenger ({r.variant}, {r.params}): {verdict}")
        print(f"   CV RMSE on the tuning seasons {r.cv_rmse:.4f}; transparent setting {setting}")
        for why in r.reasons:
            print(f"   {why}")
        for g in [*r.checkpoints, r.pooled]:
            print(f"   {pf.fmt_gap(g)}")
    if args.out is not None:
        doc = {"league": args.league, "setting": setting, "results": [asdict(r) for r in results]}
        args.out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
