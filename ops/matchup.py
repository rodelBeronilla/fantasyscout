"""The week's matchup card of web/src/lib/matchup.ts (#490, #869) in Python, for its backtest.

The web is the product; this is its reference implementation. Both read the same registry and a
shared fixture (tests/fixtures/matchup_parity.json) pins the two to the same figures: the web's
test checks the TypeScript against it and tests/test_matchup.py checks this module. ``chances`` is
the array form ops.closeness_backtest runs over thousands of simulated matchups; the dict forms
mirror the web's functions one for one.

A category's chance is Φ(margin ÷ s). For a counting category s = sigma √(games counted, both
sides); for FG% and FT% s = sigma √(G₁ ÷ A₁² + G₂ ÷ A₂²), a side's games over its projected
attempts squared, so the spread of a percentage falls as the shots add up. sigma is
``matchup.game_spread``: one game's spread in the category's own unit. The category is too close
when the chance lies within ``matchup.closeness`` of 50%.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from typing import Any

import numpy as np

from ops.standings import CATS, normal_cdf, registry

# the projected per-game column behind each counting category, and made and attempted behind
# each percentage (matchup.ts COUNTING and RATIO)
COUNTING = {
    "z_points": "proj_points_pg",
    "z_rebounds_total": "proj_rebounds_total_pg",
    "z_assists": "proj_assists_pg",
    "z_steals": "proj_steals_pg",
    "z_blocks": "proj_blocks_pg",
    "z_three_pointers_made": "proj_three_pointers_made_pg",
    "z_turnovers": "proj_turnovers_pg",
}
RATIO = {
    "z_field_goal_pct": ("proj_fgm_pg", "proj_fga_pg"),
    "z_free_throw_pct": ("proj_ftm_pg", "proj_fta_pg"),
}
LOWER_WINS = {"z_turnovers"}
# a projected line in ops.standings_backtest.STATS order: the seven counts, then fgm, fga, ftm, fta
LINE = (*COUNTING.values(), "proj_fgm_pg", "proj_fga_pg", "proj_ftm_pg", "proj_fta_pg")


def sigmas(league: str, cats: Sequence[str] = CATS, p: dict[str, Any] | None = None) -> np.ndarray:
    spread = (registry() if p is None else p)["matchup.game_spread"][league]
    return np.array([float(spread.get(c, 1)) for c in cats])


def _values(t: np.ndarray) -> np.ndarray:
    """A projected week [..., 11] as its nine category values, percentages made over attempted."""

    def pct(made: np.ndarray, att: np.ndarray) -> np.ndarray:
        return np.where(att > 0, made / np.where(att > 0, att, 1), 0.0)[..., None]

    out: np.ndarray = np.concatenate(
        [t[..., :7], pct(t[..., 7], t[..., 8]), pct(t[..., 9], t[..., 10])], axis=-1
    )
    return out


def unit_spread(a: np.ndarray, b: np.ndarray, ga: np.ndarray, gb: np.ndarray) -> np.ndarray:
    """The spread of each category's margin at sigma = 1 [..., 9]: √(games counted, both sides)
    for a count, √(G₁ ÷ A₁² + G₂ ÷ A₂²) for a percentage."""

    def per_shot(g: np.ndarray, att: np.ndarray) -> np.ndarray:
        return np.where(att > 0, g / np.where(att > 0, att, 1) ** 2, 0.0)[..., None]

    both = np.asarray(ga + gb, dtype=float)
    games = np.broadcast_to(both[..., None], (*both.shape, 7))
    fg = per_shot(ga, a[..., 8]) + per_shot(gb, b[..., 8])
    ft = per_shot(ga, a[..., 10]) + per_shot(gb, b[..., 10])
    out: np.ndarray = np.sqrt(np.concatenate([games, fg, ft], axis=-1))
    return out


def chances(
    a: np.ndarray, b: np.ndarray, ga: np.ndarray, gb: np.ndarray, sigma: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The nine categories of matchups at once. ``a`` and ``b`` [..., 11] are each side's projected
    week (the seven counts, then fgm, fga, ftm, fta), ``ga`` and ``gb`` [...] its games counted.
    Returns the first side's margin, chance and share (the margin over the larger total), [..., 9].
    """
    va, vb = _values(a), _values(b)
    edge = (va - vb) * np.array([-1.0 if c in LOWER_WINS else 1.0 for c in CATS])
    share = np.abs(edge) / np.maximum(np.maximum(np.abs(va), np.abs(vb)), 1e-9)
    s = sigma * unit_spread(a, b, ga, gb)
    z = edge / np.where(s > 0, s, 1)
    chance = np.where(s > 0, normal_cdf(z), np.where(edge > 0, 1.0, np.where(edge < 0, 0.0, 0.5)))
    return edge, chance, share


def called_wins(chance: np.ndarray, closeness: float) -> np.ndarray:
    """The categories the card calls a win: the chance more than ``closeness`` above 50%."""
    out: np.ndarray = chance - 0.5 > closeness
    return out


# ---- the web's functions, one for one -------------------------------------------------------


def _n(row: dict[str, Any], key: str) -> float:
    v = row.get(key)
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and v == v else 0.0


def week_totals(
    rows: Sequence[dict[str, Any]],
    cats: Sequence[str],
    games_of: Callable[[dict[str, Any]], float] | None = None,
) -> dict[str, Any]:
    """weekTotals without fantasy points: each category's projected total for the week."""

    def games(r: dict[str, Any]) -> float:
        return games_of(r) if games_of else _n(r, "games_this_week")

    out: dict[str, float] = {}
    shots: dict[str, list[float]] = {}
    for c in cats:
        if c in COUNTING:
            out[c] = sum(_n(r, COUNTING[c]) * games(r) for r in rows)
        elif c in RATIO:
            made = sum(_n(r, RATIO[c][0]) * games(r) for r in rows)
            attempted = sum(_n(r, RATIO[c][1]) * games(r) for r in rows)
            out[c] = made / attempted if attempted > 0 else 0.0
            shots[c] = [made, attempted]
        else:
            out[c] = 0.0
    return {"cats": out, "games": sum(games(r) for r in rows), "shots": shots}


def category_chance(
    league: str,
    cat: str,
    mine: dict[str, Any],
    theirs: dict[str, Any],
    edge: float,
    p: dict[str, Any],
) -> float:
    """categoryChance: the manager's chance of winning the category this week."""
    sigma = float(p["matchup.game_spread"][league].get(cat, 1))
    if cat in RATIO:

        def term(t: dict[str, Any]) -> float:
            att = float((t.get("shots") or {}).get(cat, [0, 0])[1])
            return float(t["games"]) / (att * att) if att > 0 else 0.0

        variance = sigma * sigma * (term(mine) + term(theirs))
    else:
        variance = sigma * sigma * (float(mine["games"]) + float(theirs["games"]))
    s = math.sqrt(variance)
    if s > 0:
        return float(normal_cdf(edge / s))
    return 1.0 if edge > 0 else 0.0 if edge < 0 else 0.5


def matchup(
    league: str,
    cats: Sequence[str],
    mine: dict[str, Any],
    theirs: dict[str, Any],
    p: dict[str, Any] | None = None,
    closeness: float | None = None,
) -> dict[str, Any]:
    """matchup: category by category against the opponent, each with its chance and call."""
    p = registry() if p is None else p
    band = float(p["matchup.closeness"]) if closeness is None else closeness
    rows = []
    for cat in cats:
        a = float(mine["cats"].get(cat, 0))
        b = float(theirs["cats"].get(cat, 0))
        edge = b - a if cat in LOWER_WINS else a - b
        share = abs(edge) / max(abs(a), abs(b), 1e-9)
        chance = category_chance(league, cat, mine, theirs, edge, p)
        result = "close" if abs(chance - 0.5) <= band else "win" if edge > 0 else "loss"
        rows.append({"cat": cat, "edge": edge, "share": share, "chance": chance, "result": result})
    return {
        "cats": rows,
        "wins": sum(r["result"] == "win" for r in rows),
        "losses": sum(r["result"] == "loss" for r in rows),
        "close": sum(r["result"] == "close" for r in rows),
    }
