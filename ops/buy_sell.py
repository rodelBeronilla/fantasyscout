"""Buy low, sell high (web/src/lib/buy-sell.ts, #739) in Python, for its backtest (#758).

The web is the product; this is its reference implementation. Both read the same registry, and a
shared fixture (tests/fixtures/buy_sell_parity.json) pins the two to the same lists: the web's
test checks the TypeScript against it and tests/test_buy_sell.py checks this module.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

SHOWN = 6  # buy-sell.ts: rows each list shows


def median(values: Sequence[float]) -> float:
    """punt-chips.ts median: 0 for none."""
    if not values:
        return 0.0
    s = sorted(values)
    mid = len(s) // 2
    return float(s[mid]) if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def buy_sell(
    league: str,
    mine: int,
    owner: Sequence[tuple[str, int]],
    projected: Callable[[str], float],
    recent: Callable[[str], float],
    healthy: Callable[[str], bool],
    start_line: float,
    p: dict[str, Any],
    *,
    min_swing: float | None = None,
    limit: int = SHOWN,
) -> dict[str, list[dict[str, Any]]]:
    """buySell: the manager's players running a swing above their projection (sell high), and
    healthy players elsewhere slumping a swing below a projection good enough to start for the
    manager (buy low). ``owner`` is the web's Map in its order."""
    reg = p["buysell.min_swing"]
    swing = float(reg[league] if isinstance(reg, dict) else reg) if min_swing is None else min_swing
    swings: list[dict[str, Any]] = []
    for pid, team in owner:
        pr, r = projected(pid), recent(pid)
        swings.append({"id": pid, "team": team, "projected": pr, "recent": r, "form": r - pr})
    sell = sorted(
        (s for s in swings if s["team"] == mine and s["form"] >= swing), key=lambda s: -s["form"]
    )[:limit]
    buy = sorted(
        (
            s
            for s in swings
            if s["team"] != mine
            and s["form"] <= -swing
            and s["projected"] >= start_line
            and healthy(s["id"])
        ),
        key=lambda s: -s["projected"],
    )[:limit]
    return {"buyLow": buy, "sellHigh": sell}
