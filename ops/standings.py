"""The standings model of web/src/lib/standings.ts (ADR 0015) in Python, for its backtest (#755).

The web is the product; this is its reference implementation. Both read the same registry
(methodology/parameters.yml) and a shared fixture (tests/fixtures/standings_parity.json) pins the
two to the same figures: the web's test checks the TypeScript against it and
tests/test_standings.py checks this module. The array forms (``spreads``, ``chance``,
``matchup_chance``) are what ops.standings_backtest runs over thousands of simulated leagues; the
dict forms mirror the web's functions one for one.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from typing import Any

import numpy as np

from ops import parameters

CATS = (
    "z_points",
    "z_rebounds_total",
    "z_assists",
    "z_steals",
    "z_blocks",
    "z_three_pointers_made",
    "z_turnovers",
    "z_field_goal_pct",
    "z_free_throw_pct",
)


def registry() -> dict[str, Any]:
    return {p["id"]: p["value"] for p in parameters.load()}


def normal_cdf(x: Any) -> Any:
    """The standard normal distribution function, Abramowitz and Stegun 7.1.26 as the web has it."""
    x = np.asarray(x, dtype=float)
    z = np.abs(x) / math.sqrt(2)
    t = 1 / (1 + 0.3275911 * z)
    poly = t * (
        0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))
    )
    erf = 1 - poly * np.exp(-z * z)
    out = np.where(x >= 0, 0.5 * (1 + erf), 0.5 * (1 - erf))
    return float(out) if out.ndim == 0 else out


def normal_pdf(x: Any) -> Any:
    return np.exp(-0.5 * np.asarray(x, dtype=float) ** 2) / math.sqrt(2 * math.pi)


def spreads(
    league: str,
    cats: Sequence[str],
    players: Any,
    fmt: str,
    games_left: float = 0,
    p: dict[str, Any] | None = None,
    *,
    scale: float | None = None,
    projection: float | None = None,
    projection_games: float | None = None,
) -> Any:
    """The standard deviation of the gap between two teams' totals per category (standingsModel).

    ``players`` may be an array (one league each): the result then has a last axis of ``cats``.
    ``scale``, ``projection`` and ``projection_games`` override the registry's, for the fits'
    grids. A rotisserie projection's error has a part that lasts (``projection``) and one whose
    variance falls with the games left (``projection_games``, #866).
    """
    p = registry() if p is None else p
    k = float(p["standings.spread_scale"][league]) if scale is None else scale
    proj = float(p["standings.projection_spread"][league]) if projection is None else projection
    passing = (
        float(p["standings.projection_spread_games"][league])
        if projection_games is None
        else projection_games
    )
    gpw = float(p["standings.games_per_week"][league])
    n = np.maximum(np.asarray(players, dtype=float), 1)[..., None]
    games = gpw if fmt == "h2h" else max(games_left, gpw)
    game = np.array([float(p["standings.game_spread"][league].get(c, 1)) for c in cats])
    extra = (proj * proj + passing * passing / games) * 2 * n if fmt == "roto" else 0
    return np.sqrt((k * game) ** 2 * 2 * n / games + extra)


def chance(gap: Any, spread: Any) -> Any:
    """The chance of finishing ahead in a category: Φ(gap ÷ spread)."""
    return normal_cdf(np.asarray(gap, dtype=float) / spread)


def matchup_chance(chances: Any) -> Any:
    """The chance of winning a matchup from its categories' chances (last axis): more than half
    the categories won wins, exactly half splits (matchupChance)."""
    c = np.asarray(chances, dtype=float)
    dist = np.zeros((*c.shape[:-1], c.shape[-1] + 1))
    dist[..., 0] = 1
    for i in range(c.shape[-1]):
        p = c[..., i : i + 1]
        nxt = np.zeros_like(dist)
        nxt[..., : i + 1] += dist[..., : i + 1] * (1 - p)
        nxt[..., 1 : i + 2] += dist[..., : i + 1] * p
        dist = nxt
    n = c.shape[-1]
    k = np.arange(n + 1)
    weight = np.where(2 * k > n, 1.0, np.where(2 * k == n, 0.5, 0.0))
    out = (dist * weight).sum(axis=-1)
    return float(out) if np.ndim(out) == 0 else out


def thirds_weights(order: Sequence[str], p: dict[str, Any] | None = None) -> dict[str, float]:
    """fit.thirds over categories ordered most in need first (thirdsWeights)."""
    w = (registry() if p is None else p)["fit.thirds"]
    third = max(1, _js_round(len(order) / 3))
    return {
        c: float(
            w["weak"] if i < third else w["strong"] if i >= len(order) - third else w["middle"]
        )
        for i, c in enumerate(order)
    }


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


# ---- the web's functions, one for one -------------------------------------------------------


def team_totals(
    roster: Sequence[str],
    cats: Sequence[str],
    cat_value: Callable[[str], dict[str, float] | None],
    availability: Callable[[str], float],
) -> dict[str, float]:
    out = dict.fromkeys(cats, 0.0)
    for pid in roster:
        v = cat_value(pid)
        if not v:
            continue
        a = availability(pid)
        for c in cats:
            out[c] += v.get(c, 0) * a
    return out


def rivals(
    rosters: Sequence[Sequence[str]], team: int, roster_spots: int, p: dict[str, Any]
) -> list[int]:
    least = max(1, math.ceil(roster_spots * float(p["standings.rival_min_share"])))
    return [t for t, r in enumerate(rosters) if t != team and len(r) >= least]


def win_chances(
    totals: list[dict[str, float]], team: int, others: list[int], spread: dict[str, float]
) -> dict[str, float]:
    out = {}
    for c, s in spread.items():
        mine = totals[team].get(c, 0)
        out[c] = (
            sum(float(normal_cdf((mine - totals[t].get(c, 0)) / s)) for t in others) / len(others)
            if others
            else 0.5
        )
    return out


def standing_weights(
    totals: list[dict[str, float]], team: int, others: list[int], spread: dict[str, float]
) -> dict[str, float] | None:
    if not others or not spread:
        return None
    raw = []
    for c, s in spread.items():
        mine = totals[team].get(c, 0)
        raw.append(
            sum(float(normal_pdf((mine - totals[t].get(c, 0)) / s)) / s for t in others)
            / len(others)
        )
    mean = sum(raw) / len(raw)
    return {c: (r / mean if mean > 0 else 1.0) for c, r in zip(spread, raw, strict=True)}


def _active(rosters: Sequence[Sequence[str]], il: Sequence[str]) -> list[list[str]]:
    return [[pid for pid in r if pid not in il] for r in rosters]


def league_standings(
    league: str,
    setup: dict[str, Any],
    cats: Sequence[str],
    cat_value: Callable[[str], dict[str, float] | None],
    availability: Callable[[str], float],
    games_left: float,
    p: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """leagueStandings: the weights, the chances, every team's totals and the rivals."""
    p = registry() if p is None else p
    mine = int(setup["mine"])
    others = rivals(setup["rosters"], mine, int(setup["rosterSpots"]), p)
    if not others or not cats:
        return None
    active = _active(setup["rosters"], setup.get("il", []))
    totals = [team_totals(r, cats, cat_value, availability) for r in active]
    ranked = [mine, *others]
    players = sum(sum(availability(pid) for pid in active[t]) for t in ranked) / len(ranked)
    spread = dict(
        zip(
            cats,
            spreads(league, cats, players, setup["format"], games_left, p).tolist(),
            strict=True,
        )
    )
    return {
        "spread": spread,
        "weights": standing_weights(totals, mine, others, spread),
        "chances": win_chances(totals, mine, others, spread),
        "totals": totals,
        "others": others,
    }


def power_rankings(
    league: str,
    setup: dict[str, Any],
    cats: Sequence[str],
    cat_value: Callable[[str], dict[str, float] | None],
    availability: Callable[[str], float],
    games_left: float,
    p: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    """powerRankings: every team with half a roster, best first."""
    p = registry() if p is None else p
    teams = rivals(setup["rosters"], -1, int(setup["rosterSpots"]), p)
    if len(teams) < 2 or not cats:
        return None
    active = _active(setup["rosters"], setup.get("il", []))
    totals = [team_totals(r, cats, cat_value, availability) for r in active]
    players = sum(sum(availability(pid) for pid in active[t]) for t in teams) / len(teams)
    spread = dict(
        zip(
            cats,
            spreads(league, cats, players, setup["format"], games_left, p).tolist(),
            strict=True,
        )
    )
    h2h = setup["format"] == "h2h"

    def ch(a: int, b: int, c: str) -> float:
        return float(normal_cdf((totals[a].get(c, 0) - totals[b].get(c, 0)) / spread[c]))

    out = []
    for team in teams:
        others = [t for t in teams if t != team]
        expected = sum(win_chances(totals, team, others, spread).values())
        matchup = (
            sum(matchup_chance([ch(team, o, c) for c in cats]) for o in others) / len(others)
            if h2h
            else None
        )
        roto = None if h2h else sum(1 + sum(ch(team, o, c) for o in others) for c in cats)
        out.append(
            {"team": team, "expectedCats": expected, "matchupWin": matchup, "rotoPoints": roto}
        )
    key = "matchupWin" if h2h else "rotoPoints"
    return sorted(out, key=lambda r: -(r[key] or 0))
