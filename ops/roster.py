"""The roster review of web/src/lib/roster-upgrades.ts (the drop rule, the minimum gain, the trade
chips) in Python, for its backtest (#757).

The web is the product; this is its reference implementation. Both read the same registry and a
shared fixture (tests/fixtures/roster_parity.json) pins the two to the same figures: the web's
test checks the TypeScript against it and tests/test_roster.py checks this module.
ops.roster_backtest runs the same rules over arrays of simulated leagues, and its tests hold the
two forms equal.

Not mirrored: the position check (keepsPositions), a roster-legality filter the backtest's
simulated leagues have no positions for.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from typing import Any


def per_league(p: dict[str, Any], pid: str, league: str) -> float:
    """A registry value, the league's own when it is kept per league."""
    v = p[pid]
    return float(v[league] if isinstance(v, dict) else v)


def drop_rule(
    league: str,
    rows: Sequence[dict[str, Any]],
    mine: Sequence[str],
    teams: int,
    roster_spots: int,
    rest: dict[str, float],
    week: bool,
    p: dict[str, Any],
) -> Callable[[str], bool]:
    """dropRule: never a player the board or the market ranks among the league's starters; and
    judging the week, only the ``roster.bench_size`` lowest-valued for the rest of the season."""
    starters = teams * math.ceil(roster_spots * per_league(p, "roster.starter_share", league))
    by_id = {r["player_id"]: r for r in rows}
    bench = set(sorted(mine, key=lambda i: rest.get(i, 0))[: int(p["roster.bench_size"])])

    def ranked(x: Any) -> bool:
        return isinstance(x, int | float) and not isinstance(x, bool) and x <= starters

    def droppable(pid: str) -> bool:
        r = by_id.get(pid)
        if r and (ranked(r.get("rank_total")) or ranked(r.get("market_rank"))):
            return False
        return not week or pid in bench

    return droppable


def _rank_of(totals: list[float], team: int) -> int:
    return 1 + sum(1 for t, v in enumerate(totals) if t != team and v > totals[team])


def suggest_upgrades(
    league: str,
    mine: Sequence[str],
    available: Sequence[str],
    rest: dict[str, float],
    cats: Sequence[str],
    cat_value: Callable[[str], dict[str, float] | None],
    totals: list[dict[str, float]],
    my_team: int,
    p: dict[str, Any],
    *,
    min_gain: float | None = None,
    droppable: Callable[[str], bool] | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    min_gain = per_league(p, "roster.min_gain", league) if min_gain is None else min_gain

    def value(i: str) -> float:
        return rest.get(i, 0)

    if not mine or not available:
        return []
    adds = sorted((i for i in available if value(i) > 0), key=lambda i: -value(i))[
        : int(p["roster.candidates"])
    ]
    drops = sorted((i for i in mine if droppable is None or droppable(i)), key=value)
    before = [_rank_of([t.get(c, 0) for t in totals], my_team) for c in cats]
    pairs: list[dict[str, Any]] = []
    for add in adds:
        for drop in drops:
            gain = value(add) - value(drop)
            if gain < min_gain:
                continue
            ups: list[str] = []
            downs: list[str] = []
            fit = 0
            for k, c in enumerate(cats):
                swing = (cat_value(add) or {}).get(c, 0) - (cat_value(drop) or {}).get(c, 0)
                after = [
                    t.get(c, 0) + (swing if team == my_team else 0) for team, t in enumerate(totals)
                ]
                rank = _rank_of(after, my_team)
                was = before[k]
                fit += was - rank
                if rank < was:
                    ups.append(c)
                elif rank > was:
                    downs.append(c)
            pairs.append(
                {"add": add, "drop": drop, "gain": gain, "fit": fit, "ups": ups, "downs": downs}
            )
    pairs.sort(key=lambda u: (-u["gain"], -u["fit"]))
    used: set[str] = set()
    out = []
    for u in pairs:
        if u["add"] in used or u["drop"] in used:
            continue
        used.update((u["add"], u["drop"]))
        out.append(u)
        if len(out) >= limit:
            break
    return out


def review_roster(
    league: str,
    mine: Sequence[str],
    available: Sequence[str],
    rest: dict[str, float],
    cats: Sequence[str],
    cat_value: Callable[[str], dict[str, float] | None],
    totals: list[dict[str, float]],
    my_team: int,
    p: dict[str, Any],
    *,
    min_gain: float | None = None,
    droppable: Callable[[str], bool] | None = None,
) -> dict[str, Any]:
    upgrades = suggest_upgrades(
        league,
        mine,
        available,
        rest,
        cats,
        cat_value,
        totals,
        my_team,
        p,
        min_gain=min_gain,
        droppable=droppable,
    )

    def value(i: str) -> float:
        return rest.get(i, 0)

    ordered = sorted(mine, key=value)
    best_add = next(
        iter(sorted((i for i in available if value(i) > 0), key=lambda i: -value(i))), None
    )
    lowest = next((i for i in ordered if droppable(i)), None) if droppable else None
    lowest = lowest if lowest is not None else (ordered[0] if ordered else None)
    weakest = (
        None
        if lowest is None
        else {
            "drop": lowest,
            "add": best_add,
            "gap": value(best_add) - value(lowest) if best_add else -value(lowest),
        }
    )
    least = per_league(p, "roster.min_gain", league) if min_gain is None else min_gain
    chips = (
        [i for i in ordered if not droppable(i) and value(best_add) - value(i) >= least]
        if droppable and best_add
        else []
    )
    return {
        "upgrades": upgrades,
        "replace": [u["drop"] for u in upgrades],
        "optimized": len(ordered) > 0 and not upgrades,
        "weakest": weakest,
        "rostered": len(ordered),
        "chips": chips,
    }
