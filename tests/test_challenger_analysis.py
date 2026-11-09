"""The #916 terms are neutral at their neutral points, and the analysis runs end to end."""

from __future__ import annotations

import numpy as np
import pytest

from ops import challenger_analysis as ca
from ops import projection_features as pf
from tests.test_projection_challenger import _cut


def _in_season(season: str, n: int, seed: int, checkpoint: float = 0.1) -> pf.Cut:
    cut = _cut(season, n, seed)
    rng = np.random.default_rng(seed)
    p = cut.parts
    games = rng.integers(0, 12, n).astype(float)
    p["games_current"] = games
    p["minutes_current"] = games * rng.uniform(5, 35, n)
    p["minutes_games_weight"] = games + rng.uniform(5, 40, n)
    p["minutes_weighted"] = p["minutes_games_weight"] * rng.uniform(10, 34, n)
    p["prior_games"] = 3.0
    p["prior_minutes"] = 60.0
    season_minutes = (p["minutes_weighted"] + p["prior_minutes"]) / (
        p["minutes_games_weight"] + p["prior_games"]
    )
    p["proj_minutes_season_pg"] = season_minutes
    p["minutes_last5_pg"] = np.where(games > 0, rng.uniform(2, 36, n), np.nan)
    p["return_minutes_factor"] = 1.0
    # the projection blends the last five games' minutes in from five games on
    p["proj_minutes_pg"] = np.where(
        games >= 5, 0.5 * season_minutes + 0.5 * p["minutes_last5_pg"], season_minutes
    )
    p["usage_weight"] = np.where(rng.uniform(size=n) < 0.1, 0.0, p["usage_weight"])
    cut.parts = p.copy()
    cut.checkpoint = checkpoint
    cut.real = pf.total(pf.score(pf.realized_line(p), cut.scale))
    cut.cache.clear()
    return cut


def test_short_of_games_is_in_season_only() -> None:
    cut = _in_season("2020-21", 40, 1)
    short = ca.short_of_games(cut)
    assert (short == (cut.parts["games_current"].to_numpy() < ca.SHORT_GAMES)).all()
    pre = _in_season("2020-21", 40, 1, checkpoint=0.0)
    assert not ca.short_of_games(pre).any()


def test_every_term_is_neutral_at_its_neutral_point() -> None:
    cut = _in_season("2020-21", 60, 2)
    base = cut.value(pf.NEUTRAL)
    assert np.allclose(ca.minutes(cut), cut.parts["proj_minutes_pg"], atol=1e-9)
    for k in ({}, {"short": 0.0, "usage": 0.0}, {"early": 0.0, "prior": 1.0}):
        assert np.allclose(ca.term_value(cut, pf.NEUTRAL, k), base, atol=1e-9)


def test_the_terms_move_only_whom_they_name() -> None:
    cut = _in_season("2020-21", 60, 3)
    base = cut.value(pf.NEUTRAL)
    short = ca.short_of_games(cut)
    moved = ca.term_value(cut, pf.NEUTRAL, {"short": 1.2})
    assert np.allclose(base - moved, 1.2 * short)
    # no usage weight: no tilt
    tilt = ca.term_value(cut, pf.NEUTRAL, {"usage": 0.5}) - base
    assert np.allclose(tilt[cut.parts["usage_weight"].to_numpy() == 0], 0.0)
    # early minutes move only players short of games with last games to read
    m = ca.minutes(cut, early=1.0)
    changed = ~np.isclose(m, cut.parts["proj_minutes_pg"].to_numpy())
    has_last = cut.parts["minutes_last5_pg"].notna().to_numpy()
    assert not (changed & ~(short & has_last)).any()


def test_the_analysis_runs_end_to_end() -> None:
    pytest.importorskip("sklearn")
    seasons = ("2020-21", "2021-22", "2022-23")
    tuning = [
        _in_season(s, 60, 10 * i + k, cp)
        for i, s in enumerate(seasons)
        for k, cp in enumerate((0.0, 0.1))
    ]
    judged = [_in_season("2023-24", 60, 99)]
    terms = {
        "short": [{"short": b} for b in (0.0, 0.5)],
        "usage": [{"usage": u} for u in (0.0, 0.2)],
    }
    doc = ca.analyse(tuning, judged, pf.NEUTRAL, resamples=20, terms=terms, repeats=1)
    assert [t["name"] for t in doc["terms"]] == ["short", "usage"]
    assert all(set(t["per_fold"]) == set(seasons) for t in doc["terms"])
    assert set(doc["importance"]["groups"]) == set(ca.GROUPS)
    segs = doc["segments"]["tuning"]
    assert np.isclose(sum(v["share_of_reduction"] for k, v in segs.items() if "pool" not in k), 1.0)
    assert [m["as_of"] for m in doc["movers"]] == [f"{s} @ 0.1" for s in (*seasons, "2023-24")]
    assert "transparent terms" in ca.report(doc)
