"""ops/buy_sell.py gives the Trade page's buy low, sell high lists (#758): the cases and the lists
are in tests/fixtures/buy_sell_parity.json, which web/src/lib/buy-sell-parity.test.ts checks the
TypeScript against too."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ops import buy_sell, standings

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "buy_sell_parity.json").read_text(encoding="utf-8")
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


@pytest.mark.parametrize("i", range(len(FIXTURE["cases"])))
def test_the_lists_match_the_web(i: int) -> None:
    c = FIXTURE["cases"][i]
    owner = [(pid, int(t)) for pid, t in c["owner"]]
    line = buy_sell.median([c["projected"][pid] for pid, t in owner if t == c["mine"]])
    got = {
        "startLine": line,
        "lists": [
            buy_sell.buy_sell(
                c["mine"],
                owner,
                lambda pid: float(c["projected"].get(pid, 0)),
                lambda pid: float(c["recent"].get(pid, 0)),
                lambda pid: pid not in c["unhealthy"],
                line,
                P,
                min_swing=s,
            )
            for s in c["minSwings"]
        ],
    }
    _close(got, FIXTURE["expected"]["cases"][i], c["name"])
