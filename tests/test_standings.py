"""ops/standings.py gives the web's standings figures (#755): the cases and the figures are in
tests/fixtures/standings_parity.json, which web/src/lib/standings.test.ts checks the TypeScript
against too."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from ops import standings

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "standings_parity.json").read_text(encoding="utf-8")
)


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
def test_the_standings_and_power_rankings_match_the_web(i: int) -> None:
    c = FIXTURE["cases"][i]
    setup = {k: c[k] for k in ("rosters", "mine", "rosterSpots", "il", "format")}

    def value(pid: str) -> dict[str, float] | None:
        out: dict[str, float] | None = c["values"].get(pid)
        return out

    def availability(pid: str) -> float:
        return float(c["availability"].get(pid, 1))

    s = standings.league_standings(
        c["league"], setup, c["cats"], value, availability, c["gamesLeft"]
    )
    power = standings.power_rankings(
        c["league"], setup, c["cats"], value, availability, c["gamesLeft"]
    )
    got = {
        "chances": s and s["chances"],
        "weights": s and s["weights"],
        "totals": s and s["totals"],
        "others": s and s["others"],
        "power": power,
    }
    _close(got, FIXTURE["expected"]["cases"][i], c["name"])


@pytest.mark.parametrize("i", range(len(FIXTURE["models"])))
def test_the_spreads_match_the_web(i: int) -> None:
    m = FIXTURE["models"][i]
    got = standings.spreads(
        m["league"], m["cats"], m["players"], m["format"], m["gamesLeft"]
    ).tolist()
    _close(dict(zip(m["cats"], got, strict=True)), FIXTURE["expected"]["models"][i])


def test_the_array_forms_agree_with_the_one_by_one_functions() -> None:
    rng = np.random.default_rng(0)
    chances = rng.uniform(size=(5, 9))
    assert np.allclose(
        standings.matchup_chance(chances), [standings.matchup_chance(r) for r in chances]
    )
    assert standings.matchup_chance([0.5, 0.5]) == pytest.approx(0.5)
    assert standings.normal_cdf(-1.3) + standings.normal_cdf(1.3) == pytest.approx(1, abs=1e-15)
