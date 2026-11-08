"""The Trade page's verdict, suggestions and finder (web/src/lib/trade-fairness.ts,
trade-impact.ts, trade-suggest.ts and league-model.ts's lenses) in Python, for their backtest
(#756).

The web is the product; this is its reference implementation. Both read the same registry and a
shared fixture (tests/fixtures/trade_parity.json) pins the two to the same figures: the web's
test checks the TypeScript against it and tests/test_trade.py checks this module. The functions
mirror the web's one for one; ops.trade_backtest runs the same rules over arrays of simulated
leagues and its tests hold the two forms equal.

Not mirrored: the position check (keepsPositions), a roster-legality filter the backtest's
simulated leagues have no positions for, and the reasons' wording (their count is kept).
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from ops import standings

Value = Callable[[str], float]


# ---- trade-fairness.ts ----------------------------------------------------------------------


def lens(give: Sequence[str], get: Sequence[str], value: Value) -> dict[str, float]:
    """A lens from the two sides' values; a player below replacement counts as zero."""
    g = sum(max(0.0, value(i)) for i in give)
    r = sum(max(0.0, value(i)) for i in get)
    net = r - g
    return {"give": g, "get": r, "net": net, "share": net / max(g, r, 1e-9)}


def market_values(players: Sequence[dict[str, Any]], value: Value) -> dict[str, float]:
    """Each player's ESPN rank priced at the value the board's player of that rank has; a player
    the market does not rank keeps their own value."""
    curve = sorted((max(0.0, value(p["player_id"])) for p in players), reverse=True)
    out = {}
    for p in players:
        r: Any = p.get("market_rank")
        ok = isinstance(r, int | float) and not isinstance(r, bool) and 1 <= r <= len(curve)
        if ok and float(r).is_integer():
            out[p["player_id"]] = curve[int(r) - 1]
        elif ok:
            out[p["player_id"]] = 0.0  # curve[r - 1] of a fractional rank is undefined: ?? 0
        else:
            out[p["player_id"]] = value(p["player_id"])
    return out


def judge(
    value: dict[str, float],
    market: dict[str, float] | None,
    categories: float | None,
    threshold: float,
    p: dict[str, Any],
) -> dict[str, Any]:
    """The verdict: even when every lens at hand calls it even; the worst severity any lens says."""
    vl, ml = p["trade.value_limits"], p["trade.market_limits"]
    cl, even_band = p["trade.category_limits"], p["trade.even"]
    severity = "fine"
    reasons = 0

    def worse(s: str) -> None:
        nonlocal severity
        if s == "terrible" or severity == "fine":
            severity = s

    if value["share"] <= vl["terrible"]:
        worse("terrible")
        reasons += 1
    elif value["share"] <= vl["bad"]:
        worse("bad")
        reasons += 1
    if market and market["share"] <= ml["terrible"]:
        worse("terrible")
        reasons += 1
    elif market and market["share"] <= ml["bad"]:
        worse("bad")
        reasons += 1
    if categories is not None and threshold > 0:
        if categories <= -cl["terrible"] * threshold:
            worse("terrible")
            reasons += 1
        elif categories <= -cl["bad"] * threshold:
            worse("bad")
            reasons += 1
    disagree = (
        bool(market)
        and market is not None
        and abs(value["share"] - market["share"]) >= p["trade.disagreement"]
        and _sign(value["share"]) != _sign(market["share"])
    )
    even = (
        abs(value["share"]) <= even_band["value"]
        and (not market or abs(market["share"]) <= even_band["market"])
        and (categories is None or abs(categories) < cl["bad"] * threshold)
    )
    return {"even": even, "severity": severity, "reasons": reasons, "disagree": disagree}


def _sign(x: float) -> float:
    return 0.0 if x == 0 else math.copysign(1.0, x)


# ---- trade-impact.ts ------------------------------------------------------------------------


@dataclass(frozen=True)
class LeagueState:
    league: str
    format: str
    cats: list[str]
    rosters: list[list[str]]
    roster_spots: int
    free_agents: list[str]
    rest: Value
    cat_value: Callable[[str], dict[str, float] | None]
    availability: Value
    games_left: float


def league_standings(state: LeagueState, team: int, p: dict[str, Any]) -> dict[str, Any] | None:
    others = standings.rivals(state.rosters, team, state.roster_spots, p)
    if not others or not state.cats:
        return None
    totals = [
        standings.team_totals(r, state.cats, state.cat_value, state.availability)
        for r in state.rosters
    ]
    ranked = [team, *others]
    players = sum(sum(state.availability(i) for i in state.rosters[t]) for t in ranked) / len(
        ranked
    )
    spread = dict(
        zip(
            state.cats,
            standings.spreads(
                state.league, state.cats, players, state.format, state.games_left, p
            ).tolist(),
            strict=True,
        )
    )
    return {"spread": spread, "totals": totals}


def rosters_after(
    state: LeagueState, mine: int, partner: int, give: Sequence[str], get: Sequence[str]
) -> dict[str, dict[str, Any]]:
    """Both rosters after the trade: a side that receives more drops its lowest-valued players,
    one that sends more picks up the best free agents, the manager's side first."""
    taken = {*give, *get}

    def settle(team: int, out: Sequence[str], incoming: Sequence[str]) -> dict[str, Any]:
        before = state.rosters[team]
        after = [i for i in before if i not in out] + list(incoming)
        dropped = []
        while len(after) > len(before):
            worst = after[0]
            for i in after[1:]:
                if state.rest(i) < state.rest(worst):
                    worst = i
            after = [i for i in after if i != worst]
            dropped.append(worst)
        added = []
        for i in state.free_agents:
            if len(after) >= len(before):
                break
            if i in taken:
                continue
            taken.add(i)
            after.append(i)
            added.append(i)
        return {"team": team, "after": after, "dropped": dropped, "added": added}

    return {"mine": settle(mine, give, get), "partner": settle(partner, get, give)}


def _score(state: LeagueState, chances: dict[str, float], rival_count: int) -> float:
    wins = sum(chances.values())
    return len(chances) + wins * rival_count if state.format == "roto" else wins


def trade_impact(
    state: LeagueState,
    st: dict[str, Any],
    mine: int,
    partner: int,
    give: Sequence[str],
    get: Sequence[str],
    p: dict[str, Any],
) -> dict[str, Any]:
    sides = rosters_after(state, mine, partner, give, get)
    totals = list(st["totals"])
    totals[mine] = standings.team_totals(
        sides["mine"]["after"], state.cats, state.cat_value, state.availability
    )
    totals[partner] = standings.team_totals(
        sides["partner"]["after"], state.cats, state.cat_value, state.availability
    )

    def change(team: int) -> dict[str, Any]:
        others = standings.rivals(state.rosters, team, state.roster_spots, p)
        before = standings.win_chances(st["totals"], team, others, st["spread"])
        after = standings.win_chances(totals, team, others, st["spread"])
        sb, sa = _score(state, before, len(others)), _score(state, after, len(others))
        return {
            "before": before,
            "after": after,
            "scoreBefore": sb,
            "scoreAfter": sa,
            "gain": sa - sb,
        }

    m, q = change(mine), change(partner)
    step = float(p["trade.category_change"])

    def moves(t: dict[str, Any]) -> tuple[list[str], list[str]]:
        up = [c for c in state.cats if t["after"].get(c, 0) - t["before"].get(c, 0) >= step]
        down = [c for c in state.cats if t["before"].get(c, 0) - t["after"].get(c, 0) >= step]
        return up, down

    ups, downs = moves(m)
    pups, pdowns = moves(q)
    return {
        "mine": m,
        "partner": q,
        "sides": sides,
        "ups": ups,
        "downs": downs,
        "partnerUps": pups,
        "partnerDowns": pdowns,
    }


def team_needs(
    state: LeagueState, st: dict[str, Any], team: int, p: dict[str, Any]
) -> dict[str, list[str]]:
    others = standings.rivals(state.rosters, team, state.roster_spots, p)
    chances = standings.win_chances(st["totals"], team, others, st["spread"])
    weights = standings.standing_weights(st["totals"], team, others, st["spread"]) or {}
    bands = p["trade.chance_bands"]
    return {
        "swing": sorted(state.cats, key=lambda c: -weights.get(c, 0))[:3],
        "conceding": [c for c in state.cats if chances.get(c, 0.5) < bands["conceding"]],
        "locked": [c for c in state.cats if chances.get(c, 0.5) > bands["locked"]],
    }


def objective(mine_gain: float, partner_gain: float, threshold: float) -> str:
    me = 1 if mine_gain >= threshold else -1 if mine_gain <= -threshold else 0
    them = 1 if partner_gain >= threshold else -1 if partner_gain <= -threshold else 0
    if me > 0 and them > 0:
        return "win-win"
    if me > 0:
        return "you"
    if them > 0:
        return "them"
    if me == 0 and them == 0:
        return "even"
    return "neither"


def meaningful_gain(league: str, p: dict[str, Any]) -> float:
    g = p["trade.meaningful_gain"]
    return float(g[league] if isinstance(g, dict) else g)


def meaningful(state: LeagueState, team: int, p: dict[str, Any]) -> float:
    gain = meaningful_gain(state.league, p)
    if state.format == "roto":
        return gain * max(1, len(standings.rivals(state.rosters, team, state.roster_spots, p)))
    return gain


# ---- league-model.ts ------------------------------------------------------------------------


@dataclass(frozen=True)
class FairnessModel:
    state: LeagueState | None
    mine: int
    value: Value
    market: dict[str, float]
    ranked: Callable[[str], bool]


def trade_lenses(
    model: FairnessModel, partner: int, give: Sequence[str], get: Sequence[str]
) -> dict[str, Any]:
    settled = (
        rosters_after(model.state, model.mine, partner, give, get)["mine"]
        if model.state and partner >= 0
        else None
    )
    outgoing = [*give, *(settled["dropped"] if settled else [])]
    incoming = [*get, *(settled["added"] if settled else [])]
    value = lens(outgoing, incoming, model.value)
    ranked = any(model.ranked(i) for i in [*give, *get])
    market = lens(outgoing, incoming, lambda i: model.market.get(i, 0)) if ranked else None
    return {"value": value, "market": market, "settled": settled}


def acceptable(
    model: FairnessModel, partner: int, give: Sequence[str], get: Sequence[str], p: dict[str, Any]
) -> bool:
    lenses = trade_lenses(model, partner, give, get)
    value, market = lenses["value"], lenses["market"]
    return bool(
        value["share"] > p["trade.value_limits"]["bad"]
        and (not market or market["share"] > p["trade.market_limits"]["bad"])
    )


# ---- trade-suggest.ts -----------------------------------------------------------------------


def combinations[T](items: Sequence[T], most: int) -> list[list[T]]:
    """Every subset with 1 to ``most`` members, in the web's depth-first order."""
    out: list[list[T]] = []

    def walk(start: int, chosen: list[T]) -> None:
        if chosen:
            out.append(chosen)
        if len(chosen) >= most:
            return
        for i in range(start, len(items)):
            walk(i + 1, [*chosen, items[i]])

    walk(0, [])
    return out


def open_side(give: Sequence[str], get: Sequence[str], rest: dict[str, float]) -> str:
    if not give:
        return "give"
    if not get:
        return "get"

    def value(ids: Sequence[str]) -> float:
        return sum(rest.get(i, 0) for i in ids)

    return "give" if value(give) < value(get) else "get"


Effect = Callable[[list[str], list[str]], dict[str, Any]]


def suggest_trades(
    give: list[str],
    get: list[str],
    mine: list[str],
    theirs: list[str],
    rest: dict[str, float],
    p: dict[str, Any],
    *,
    effect: Effect | None = None,
    min_gain: float | None = None,
    win_win: bool = False,
    accept: Callable[[list[str], list[str]], bool] | None = None,
    max_add: int | None = None,
    tolerance: float | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    search, sug = p["trade.search"], p["trade.suggest"]
    max_add = int(search["max_add"]) if max_add is None else max_add
    tolerance = float(sug["tolerance"]) if tolerance is None else tolerance
    min_gain = float(sug["min_gain"]) if min_gain is None else min_gain
    if not give and not get:
        return []

    def value(ids: Sequence[str]) -> float:
        return sum(max(0.0, rest.get(i, 0)) for i in ids)

    side = open_side(give, get, rest)
    roster = [i for i in (mine if side == "give" else theirs) if i not in give and i not in get]
    candidates = sorted((i for i in roster if rest.get(i, 0) > 0), key=lambda i: -rest.get(i, 0))[
        : int(search["pool"])
    ]
    add = min(max_add, int(search["max_add_both"])) if give and get else max_add
    out: list[dict[str, Any]] = []
    for combo in combinations(candidates, add):
        g = [*give, *combo] if side == "give" else give
        r = [*get, *combo] if side == "get" else get
        net = value(r) - value(g)
        scale = max(value(g), value(r), 1)
        if accept and not accept(g, r):
            continue
        if effect:
            e = effect(g, r)
            if e["gain"] < min_gain:
                continue
            if (
                e["partnerGain"] <= 0
                if win_win
                else net > tolerance * scale and e["partnerGain"] < 0
            ):
                continue
            out.append({"give": g, "get": r, "net": net, "effect": e})
        else:
            if abs(net) > tolerance * scale:
                continue
            out.append({"give": g, "get": r, "net": net, "effect": None})

    def size(s: dict[str, Any]) -> int:
        return len(s["give"]) + len(s["get"])

    if effect:
        out.sort(key=lambda s: (-s["effect"]["gain"], -s["effect"]["partnerGain"], size(s)))
    else:
        out.sort(key=lambda s: (-s["net"], size(s)))
    return out[:limit]


def find_trades(
    mine: list[str],
    partners: list[tuple[int, list[str]]],
    rest: dict[str, float],
    effect: Callable[[int, list[str], list[str]], dict[str, Any]],
    min_gain: float,
    p: dict[str, Any],
    *,
    win_win: bool = False,
    accept: Callable[[int, list[str], list[str]], bool] | None = None,
    candidates: int | None = None,
    per_partner: int | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """The finder: one-for-one, two-for-one and one-for-two trades with every partner, kept when
    they raise the manager's expected categories by ``min_gain`` and give the partner a reason to
    say yes; biggest gain first."""
    search = p["trade.search"]
    n = int(search["candidates"]) if candidates is None else candidates

    def value(ids: Sequence[str]) -> float:
        return sum(max(0.0, rest.get(i, 0)) for i in ids)

    def top(roster: Sequence[str]) -> list[str]:
        return sorted((i for i in roster if rest.get(i, 0) > 0), key=lambda i: -rest.get(i, 0))[:n]

    def key(t: dict[str, Any]) -> tuple[float, float]:
        return (-t["effect"]["gain"], -t["effect"]["partnerGain"])

    mine_top = top(mine)
    out: list[dict[str, Any]] = []
    for team, roster in partners:
        theirs = top(roster)
        found = []
        shapes = [
            (combinations(mine_top, 1), combinations(theirs, 1)),
            ([c for c in combinations(mine_top, 2) if len(c) == 2], combinations(theirs, 1)),
            (combinations(mine_top, 1), [c for c in combinations(theirs, 2) if len(c) == 2]),
        ]
        for gives, gets in shapes:
            for give in gives:
                for get in gets:
                    if accept and not accept(team, give, get):
                        continue
                    e = effect(team, give, get)
                    net = value(get) - value(give)
                    if e["gain"] < min_gain or (e["partnerGain"] <= 0 and (win_win or net > 0)):
                        continue
                    found.append(
                        {"partner": team, "give": give, "get": get, "net": net, "effect": e}
                    )
        found.sort(key=key)
        out.extend(found[: int(search["per_partner"]) if per_partner is None else per_partner])
    out.sort(key=key)
    return out[:limit]
