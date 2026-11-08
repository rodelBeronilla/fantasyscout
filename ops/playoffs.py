"""The playoff odds of web/src/lib/playoff-odds.ts (#821, #872) in Python, for their backtest.

The web is the product; this is its reference implementation. A shared fixture
(tests/fixtures/playoffs_parity.json) pins the two to the same figures: the web's test checks the
TypeScript against it and tests/test_playoffs.py checks this module.

The web's draws come from a seeded mulberry32, one call after another. The k-th call is a
function of the seed and k alone, so ``uniforms`` computes any run of them at once and the
simulation here makes exactly the web's draws in the web's order:

- per simulated season, when ``playoffs.season_share`` is above 0, two draws per team and
  category for that season's shift (Box-Muller, the cosine branch), teams then categories;
- then each week's matchups in order, one draw per category;
- then one draw per team to break a level tie at random.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np

from ops.standings import normal_cdf

SEED = 821
MASK = 0xFFFFFFFF
INCREMENT = 0x6D2B79F5


def uniforms(seed: int, start: int, count: int) -> np.ndarray:
    """Calls start + 1 to start + count of seededRandom(seed), at once."""
    k = np.arange(start + 1, start + count + 1, dtype=np.uint64)
    a = (np.uint64(seed & MASK) + k * np.uint64(INCREMENT)) & np.uint64(MASK)

    def imul(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        out: np.ndarray = (x * y) & np.uint64(MASK)
        return out

    t = imul(a ^ (a >> np.uint64(15)), np.uint64(1) | a)
    t = ((t + imul(t ^ (t >> np.uint64(7)), np.uint64(61) | t)) & np.uint64(MASK)) ^ t
    out: np.ndarray = ((t ^ (t >> np.uint64(14))) & np.uint64(MASK)).astype(float) / 4294967296.0
    return out


def round_robin(teams: int, weeks: int) -> list[list[tuple[int, int]]]:
    """roundRobin: the circle method, a bye each week in an odd league."""
    n = teams if teams % 2 == 0 else teams + 1
    if n < 2:
        return [[] for _ in range(weeks)]
    out = []
    for w in range(weeks):
        turn = w % (n - 1)

        def at(slot: int, turn: int = turn) -> int:
            return n - 1 if slot == n - 1 else (slot + turn) % (n - 1)

        week = []
        for slot in range(n // 2):
            a, b = at(slot), at(n - 1 - slot)
            if a < teams and b < teams:
                week.append((a, b))
        out.append(week)
    return out


def draws_per_season(teams: int, cats: int, weeks: Sequence[Sequence[Any]], shifted: bool) -> int:
    return (2 * teams * cats if shifted else 0) + sum(len(w) for w in weeks) * cats + teams


def season_draws(
    sims: int, teams: int, cats: int, weeks: Sequence[Sequence[Any]], shifted: bool, seed: int
) -> tuple[np.ndarray | None, list[np.ndarray], np.ndarray]:
    """Every simulated season's draws: the shifts [S, T, C] (normal; None unshifted), each
    week's category draws [S, M_w, C] and the tie-break draws [S, T]."""
    per = draws_per_season(teams, cats, weeks, shifted)
    u = uniforms(seed, 0, sims * per).reshape(sims, per)
    at = 0
    shift = None
    if shifted:
        pair = u[:, : 2 * teams * cats].reshape(sims, teams, cats, 2)
        shift = np.sqrt(-2 * np.log(1 - pair[..., 0])) * np.cos(2 * math.pi * pair[..., 1])
        at = 2 * teams * cats
    week_draws = []
    for w in weeks:
        week_draws.append(u[:, at : at + len(w) * cats].reshape(sims, len(w), cats))
        at += len(w) * cats
    return shift, week_draws, u[:, at : at + teams]


def tally_weeks(
    won: list[np.ndarray], weeks: Sequence[Sequence[tuple[int, int]]], teams: int, cats: int,
    tally: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:  # fmt: skip
    """Wins, losses and ties [..., T] from the categories the first side of each matchup took
    each week (``won[w]`` [..., M_w])."""
    shape = won[0].shape[:-1] if won else ()
    w = np.zeros((*shape, teams))
    lo = np.zeros((*shape, teams))
    ti = np.zeros((*shape, teams))
    for k, week in zip(won, weeks, strict=True):
        if not week:
            continue
        a = np.eye(teams)[[m[0] for m in week]]  # [M, T]
        b = np.eye(teams)[[m[1] for m in week]]
        if tally == "categories":
            w += k @ a + (cats - k) @ b
            lo += (cats - k) @ a + k @ b
        else:
            tie = (2 * k == cats).astype(float)
            first = (2 * k > cats).astype(float)
            second = 1 - tie - first
            ti += tie @ a + tie @ b
            w += first @ a + second @ b
            lo += second @ a + first @ b
    return w, lo, ti


def share(w: np.ndarray, lo: np.ndarray, ti: np.ndarray) -> np.ndarray:
    games = w + lo + ti
    out: np.ndarray = np.where(games > 0, (w + ti / 2) / np.where(games > 0, games, 1), 0.5)
    return out


def made_cut(
    w: np.ndarray, lo: np.ndarray, ti: np.ndarray, jitter: np.ndarray, spots: int
) -> np.ndarray:
    """1 for the teams the table puts inside the cut [..., T]: by winning share, then wins, a level
    tie falling by ``jitter`` (lower first)."""
    order = np.lexsort((jitter, -w, -share(w, lo, ti)), axis=-1)
    out = np.zeros(w.shape)
    np.put_along_axis(out, order[..., :spots], 1.0, axis=-1)
    return out


def chances(
    totals: np.ndarray, spread: np.ndarray, weeks: Sequence[Sequence[tuple[int, int]]],
    shift: np.ndarray | None, season_share: float,
) -> list[np.ndarray]:  # fmt: skip
    """Each week's chance that the first side takes each category [..., M_w, C]. ``totals``
    [T, C]; with a shift [S, T, C], that season's lasting part of the gap is drawn and the week
    keeps the rest of the spread."""
    out = []
    for week in weeks:
        a = np.array([m[0] for m in week], dtype=int)
        b = np.array([m[1] for m in week], dtype=int)
        gap = totals[a] - totals[b]  # [M, C]
        if shift is None or season_share <= 0:
            out.append(normal_cdf(gap / spread))
        else:
            lasting = math.sqrt(season_share / 2) * spread * (shift[:, a] - shift[:, b])
            out.append(normal_cdf((gap + lasting) / (math.sqrt(1 - season_share) * spread)))
    return out


def simulate_odds(
    totals: Sequence[dict[str, float]],
    spread: dict[str, float],
    cats: Sequence[str],
    records: Sequence[dict[str, float] | None],
    weeks: Sequence[Sequence[tuple[int, int]]],
    tally: str,
    spots: int,
    sims: int,
    seed: int = SEED,
    season_share: float = 0.0,
) -> dict[str, list[float]]:
    """simulateOdds, the web's draws one for one."""
    teams = len(totals)
    n = len(cats)
    tot = np.array([[t.get(c, 0.0) for c in cats] for t in totals], dtype=float).reshape(teams, n)
    sd = np.array([spread.get(c, 1.0) for c in cats])
    shifted = season_share > 0
    shift, week_draws, jitter = season_draws(sims, teams, n, weeks, shifted, seed)
    p = chances(tot, sd, weeks, shift, season_share)
    won = [(d < c).sum(-1).astype(float) for d, c in zip(week_draws, p, strict=True)]
    w, lo, ti = tally_weeks(won, weeks, teams, n, tally)
    start = [r or {"wins": 0, "losses": 0, "ties": 0} for r in records]
    start += [{"wins": 0, "losses": 0, "ties": 0}] * (teams - len(start))
    w = w + np.array([r["wins"] for r in start], dtype=float)
    lo = lo + np.array([r["losses"] for r in start], dtype=float)
    ti = ti + np.array([r["ties"] for r in start], dtype=float)
    made = made_cut(w, lo, ti, jitter, spots)
    return {
        "odds": made.mean(0).tolist(),
        "wins": (w + ti / 2).mean(0).tolist(),
        "losses": (lo + ti / 2).mean(0).tolist(),
    }
