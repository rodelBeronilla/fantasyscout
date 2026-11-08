"""ops/roster.py gives My Team's roster review (#757): the cases and the figures are in
tests/fixtures/roster_parity.json, which web/src/lib/roster-parity.test.ts checks the TypeScript
against too."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ops import roster, standings

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "roster_parity.json").read_text(encoding="utf-8")
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


def compute(c: dict[str, Any]) -> dict[str, Any]:
    mine = c["rosters"][c["myTeam"]]
    rest = {k: float(v) for k, v in c["rest"].items()}
    droppable = roster.drop_rule(
        "nba", c["rows"], mine, c["teams"], c["rosterSpots"], rest, c["week"], P
    )

    def review(min_gain: float, rule: bool) -> dict[str, Any]:
        return roster.review_roster(
            "nba",
            mine,
            c["available"],
            rest,
            c["cats"],
            lambda i: c["values"].get(i),
            c["totals"],
            c["myTeam"],
            P,
            min_gain=min_gain,
            droppable=droppable if rule else None,
        )

    return {
        "droppable": {i: droppable(i) for i in mine},
        "reviews": [{"rule": review(g, True), "anyone": review(g, False)} for g in c["minGains"]],
    }


@pytest.mark.parametrize("i", range(len(FIXTURE["cases"])))
def test_the_review_matches_the_web(i: int) -> None:
    c = FIXTURE["cases"][i]
    _close(compute(c), FIXTURE["expected"]["cases"][i], c["name"])
