"""ops/matchup.py gives the web's matchup card figures (#869): the cases and the figures are in
tests/fixtures/matchup_parity.json, which web/src/lib/matchup.test.ts checks the TypeScript against
too."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from ops import matchup
from ops.standings import CATS, registry

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "matchup_parity.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("i", range(len(FIXTURE["cases"])))
def test_the_card_matches_the_web(i: int) -> None:
    c = FIXTURE["cases"][i]
    got = matchup.matchup(
        c["league"], c["cats"], c["mine"], c["theirs"], closeness=c.get("closeness")
    )
    want = FIXTURE["expected"]["cases"][i]
    assert [r["result"] for r in got["cats"]] == [r["result"] for r in want["cats"]], c["name"]
    for g, w in zip(got["cats"], want["cats"], strict=True):
        for k in ("edge", "share", "chance"):
            assert g[k] == pytest.approx(w[k], abs=1e-12), (c["name"], g["cat"], k)
    assert [got[k] for k in ("wins", "losses", "close")] == [
        want[k] for k in ("wins", "losses", "close")
    ]


def test_the_array_form_gives_the_first_case() -> None:
    c = FIXTURE["cases"][0]
    assert c["cats"] == list(CATS)

    def line(t: dict) -> np.ndarray:  # type: ignore[type-arg]
        counts = [t["cats"][k] for k in CATS[:7]]
        fg, ft = t["shots"]["z_field_goal_pct"], t["shots"]["z_free_throw_pct"]
        return np.array([[*counts, fg[0], fg[1], ft[0], ft[1]]], dtype=float)

    edge, chance, _ = matchup.chances(
        line(c["mine"]),
        line(c["theirs"]),
        np.array([float(c["mine"]["games"])]),
        np.array([float(c["theirs"]["games"])]),
        matchup.sigmas("nba", CATS, registry()),
    )
    want = FIXTURE["expected"]["cases"][0]["cats"]
    # the fixture's percentages are rounded; the chance follows the shots
    assert chance[0, :7].tolist() == pytest.approx([r["chance"] for r in want[:7]], abs=1e-12)
    assert edge[0, 6] == pytest.approx(want[6]["edge"])
