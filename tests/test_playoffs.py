"""ops/playoffs.py gives the web's playoff odds draw for draw (#872): the cases and the figures are
in tests/fixtures/playoffs_parity.json, which web/src/lib/playoff-odds.test.ts checks the
TypeScript against too."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from ops import playoffs

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "playoffs_parity.json").read_text(encoding="utf-8")
)


def test_the_draws_are_the_webs() -> None:
    d = FIXTURE["draws"]
    got = playoffs.uniforms(d["seed"], 0, d["count"])
    assert got.tolist() == pytest.approx(FIXTURE["expected"]["draws"], abs=1e-15)
    # any run of calls at once: calls 5 to 12 are the tail of the first twelve
    assert playoffs.uniforms(d["seed"], 4, 8).tolist() == pytest.approx(got[4:].tolist(), abs=0)


@pytest.mark.parametrize("i", range(len(FIXTURE["robins"])))
def test_the_round_robin_is_the_webs(i: int) -> None:
    teams, weeks = FIXTURE["robins"][i]
    got = [[list(m) for m in w] for w in playoffs.round_robin(teams, weeks)]
    assert got == FIXTURE["expected"]["robins"][i]


@pytest.mark.parametrize("i", range(len(FIXTURE["cases"])))
def test_the_odds_are_the_webs(i: int) -> None:
    c = FIXTURE["cases"][i]
    got = playoffs.simulate_odds(
        c["totals"],
        c["spread"],
        c["cats"],
        c["records"],
        playoffs.round_robin(*c["robin"]),
        c["tally"],
        c["spots"],
        c["sims"],
        season_share=c["seasonShare"],
    )
    want = FIXTURE["expected"]["cases"][i]
    for k in ("odds", "wins", "losses"):
        assert got[k] == pytest.approx(want[k], abs=1e-12), (c["name"], k)


def test_a_tie_for_the_last_place_shares_it() -> None:
    from ops.playoff_backtest import realized_made

    w = np.array([[5.0, 4.0, 4.0, 1.0]])
    lo = 6 - w
    made = realized_made(w, lo, np.zeros_like(w), 2)
    assert made.tolist() == [[1.0, 0.5, 0.5, 0.0]]
    level = realized_made(np.zeros((1, 4)), np.zeros((1, 4)), np.zeros((1, 4)), 2)
    assert level.tolist() == [[0.5, 0.5, 0.5, 0.5]]
