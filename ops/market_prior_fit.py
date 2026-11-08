"""Fit the market prior's two parameters on the tuning seasons (#832).

    uv run python -m ops.market_prior_fit players-2020-21.csv players-2021-22.csv ...

Reads the per-player figures ops.walk_forward writes with ``--players-out`` (the board as built,
the board's value of each player's draft rank, his games that season, what he then did) and scores
every point of the grid with ``walk_forward.blend``, the formula mart_board applies. The rule was
set on #832 before any run:

- the grid: weight 0 to 1 in steps of 0.05, fade_games in FADES;
- the pick: the highest mean Spearman over the first-game-day and tenth checkpoints of the tuning
  seasons, among the points whose RMSE is no worse than the board's at every one of them;
- ties go to the smaller weight, then the faster fade.

Only the tuning seasons are read: a file holding any other season is refused, so the judged and
held-out seasons cannot leak into the fit.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import parameters
from ops.walk_forward import _spearman, blend

TUNING = {"nba": {"2020-21", "2021-22", "2022-23"}}
CHECKPOINTS = (0.0, 0.1)
WEIGHTS = tuple(round(0.05 * i, 2) for i in range(21))
FADES = (1, 2, 3, 5, 8, 12, 20)


@dataclass(frozen=True)
class Point:
    weight: float
    fade_games: int
    spearman: float
    # the worst, over the tuning checkpoints, of RMSE with the prior minus without
    worst_rmse_gap: float


def _rmse(pred: np.ndarray, real: np.ndarray) -> float:
    return float(np.sqrt(np.mean((pred - real) ** 2)))


def score(cuts: list[Any], weight: float, fade: int) -> Point:
    """One grid point over the checkpoints: mean Spearman, and the worst RMSE gap."""
    spearmans, gaps = [], []
    for q in cuts:
        own = q["board_value"].to_numpy(float)
        real = q["realized_value"].to_numpy(float)
        on = blend(
            own,
            q["market_prior_value"].to_numpy(float),
            q["market_prior_games"].to_numpy(float),
            weight=weight,
            fade_games=fade,
        )
        spearmans.append(_spearman(on, real))
        gaps.append(_rmse(on, real) - _rmse(own, real))
    return Point(weight, fade, float(np.mean(spearmans)), float(max(gaps)))


def pick(points: list[Point]) -> Point:
    """The declared rule: RMSE no worse anywhere, then Spearman, then smaller weight and fade."""
    allowed = [p for p in points if p.worst_rmse_gap <= 0]
    return max(allowed, key=lambda p: (round(p.spearman, 12), -p.weight, -p.fade_games))


def load(paths: list[Path], min_games: int) -> list[Any]:
    """The tuning checkpoints' judged players, one frame per season and checkpoint."""
    df = pd.concat([pd.read_csv(p, dtype={"season": str}) for p in paths])
    seasons = set(df["season"])
    league = str(df["league"].iloc[0]) if "league" in df else "nba"
    if not seasons <= TUNING.get(league, set()):
        msg = f"only the tuning seasons may be fitted on: {sorted(seasons - TUNING[league])}"
        raise SystemExit(msg)
    q = df[df["checkpoint"].isin(CHECKPOINTS) & (df["realized_games"] >= min_games)]
    return [g for _, g in q.groupby(["season", "checkpoint"])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("players", type=Path, nargs="+", help="ops.walk_forward --players-out")
    args = parser.parse_args(argv)
    min_games = int({p["id"]: p["value"] for p in parameters.load()}["backtest.min_games"])
    cuts = load(args.players, min_games)
    points = [score(cuts, w, f) for w in WEIGHTS for f in FADES]
    off = score(cuts, 0.0, FADES[0])
    for f in FADES:
        row = [p for p in points if p.fade_games == f]
        print(
            f"fade {f:>2}: "
            + " ".join(
                f"{p.weight:.2f}:{p.spearman:.4f}{'' if p.worst_rmse_gap <= 0 else '*'}"
                for p in row
            )
        )
    best = pick(points)
    print(f"off: mean Spearman {off.spearman:.4f} over {len(cuts)} checkpoints")
    print(
        f"pick: weight {best.weight}, fade_games {best.fade_games}: mean Spearman"
        f" {best.spearman:.4f}, worst RMSE gap {best.worst_rmse_gap:+.4f}"
        " (* above: RMSE worse somewhere)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
