"""ops/trade.py gives the Trade page's figures (#756): the cases and the figures are in
tests/fixtures/trade_parity.json, which web/src/lib/trade-parity.test.ts checks the TypeScript
against too."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ops import standings, trade

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "trade_parity.json").read_text(encoding="utf-8")
)
P = standings.registry()


def _close(a: Any, b: Any, where: str = "") -> None:
    if isinstance(b, float | int) and not isinstance(b, bool) and a is not None:
        assert a == pytest.approx(b, abs=1e-12), where
    elif isinstance(b, dict):
        assert list(a) == list(b), where
        for k in b:
            _close(a[k], b[k], f"{where}.{k}")
    elif isinstance(b, list):
        assert len(a) == len(b), where
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            _close(x, y, f"{where}[{i}]")
    else:
        assert a == b, where


def _listed(t: dict[str, Any]) -> dict[str, Any]:
    e = t["effect"]
    return {
        **({"partner": t["partner"]} if "partner" in t else {}),
        "give": t["give"],
        "get": t["get"],
        "net": t["net"],
        "gain": e["gain"] if e else None,
        "partnerGain": e["partnerGain"] if e else None,
    }


def compute(c: dict[str, Any]) -> dict[str, Any]:
    state = trade.LeagueState(
        league=c["league"],
        format=c["format"],
        cats=c["cats"],
        rosters=c["rosters"],
        roster_spots=c["rosterSpots"],
        free_agents=c["freeAgents"],
        rest=lambda i: float(c["rest"].get(i, 0)),
        cat_value=lambda i: c["values"].get(i),
        availability=lambda i: float(c["availability"].get(i, 1)),
        games_left=c["gamesLeft"],
    )
    mine = c["mine"]
    st = trade.league_standings(state, mine, P)
    assert st is not None
    ids = [i for r in c["rosters"] for i in r] + c["freeAgents"]
    market = trade.market_values(
        [{"player_id": i, "market_rank": c["marketRank"].get(i)} for i in ids],
        lambda i: float(c["rest"].get(i, 0)),
    )
    fairness = trade.FairnessModel(
        league=c["league"],
        state=state,
        mine=mine,
        value=lambda i: float(c["rest"].get(i, 0)),
        market=market,
        ranked=lambda i: i in c["marketRank"],
    )
    threshold = trade.meaningful(state, mine, P)

    def effect(partner: int, g: list[str], r: list[str]) -> dict[str, Any]:
        e = trade.trade_impact(state, st, mine, partner, g, r, P)
        return {
            "gain": e["mine"]["gain"],
            "partnerGain": e["partner"]["gain"],
            "ups": e["ups"],
            "downs": e["downs"],
        }

    floored = {i: max(0.0, float(c["rest"].get(i, 0))) for i in ids}
    partners = [
        (t, c["rosters"][t]) for t in standings.rivals(c["rosters"], mine, c["rosterSpots"], P)
    ]

    def finder(win_win: bool) -> list[dict[str, Any]]:
        return [
            _listed(t)
            for t in trade.find_trades(
                c["rosters"][mine],
                partners,
                floored,
                effect,
                threshold,
                P,
                win_win=win_win,
                accept=lambda t, g, r: trade.acceptable(fairness, t, g, r, P),
            )
        ]

    def suggest(s: dict[str, Any], win_win: bool, model: bool) -> list[dict[str, Any]]:
        partner = s["partner"]
        return [
            _listed(t)
            for t in trade.suggest_trades(
                s["give"],
                s["get"],
                c["rosters"][mine],
                c["rosters"][partner],
                floored,
                P,
                effect=(lambda g, r: effect(partner, g, r)) if model else None,
                min_gain=threshold,
                win_win=win_win,
                accept=lambda g, r: trade.acceptable(fairness, partner, g, r, P),
            )
        ]

    trades = []
    for t in c["trades"]:
        impact = trade.trade_impact(state, st, mine, t["partner"], t["give"], t["get"], P)
        lenses = trade.trade_lenses(fairness, t["partner"], t["give"], t["get"])
        fair = trade.judge(
            lenses["value"], lenses["market"], impact["mine"]["gain"], threshold, P, c["league"]
        )
        trades.append(
            {
                "mine": {k: impact["mine"][k] for k in ("scoreBefore", "scoreAfter", "gain")},
                "partner": {k: impact["partner"][k] for k in ("scoreBefore", "scoreAfter", "gain")},
                "sides": impact["sides"],
                "ups": impact["ups"],
                "downs": impact["downs"],
                "partnerUps": impact["partnerUps"],
                "partnerDowns": impact["partnerDowns"],
                "value": lenses["value"],
                "market": lenses["market"],
                "verdict": fair,
                "acceptable": trade.acceptable(fairness, t["partner"], t["give"], t["get"], P),
                "objective": trade.objective(
                    impact["mine"]["gain"], impact["partner"]["gain"], threshold
                ),
            }
        )
    return {
        "spread": st["spread"],
        "totals": st["totals"],
        "market": market,
        "threshold": threshold,
        "needs": trade.team_needs(state, st, mine, P),
        "trades": trades,
        "finder": {"winWin": finder(True), "any": finder(False)},
        "suggest": [
            {
                "winWin": suggest(s, True, True),
                "any": suggest(s, False, True),
                "points": suggest(s, False, False),
            }
            for s in c["suggest"]
        ],
    }


@pytest.mark.parametrize("i", range(len(FIXTURE["cases"])))
def test_the_verdict_suggestions_and_finder_match_the_web(i: int) -> None:
    c = FIXTURE["cases"][i]
    _close(compute(c), FIXTURE["expected"]["cases"][i], c["name"])


def test_the_combinations_walk_in_the_webs_order() -> None:
    assert trade.combinations(["a", "b", "c"], 2) == [
        ["a"],
        ["a", "b"],
        ["a", "c"],
        ["b"],
        ["b", "c"],
        ["c"],
    ]


def test_objective_and_lens() -> None:
    assert trade.objective(0.1, 0.1, 0.05) == "win-win"
    assert trade.objective(0.0, -0.1, 0.05) == "neither"
    assert trade.lens(["a"], ["b"], {"a": 2.0, "b": -1.0}.__getitem__)["share"] == -1
