"""The projection's features in Python are the mart's, and are fitted and judged as declared on
#771."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd
import pytest
import yaml

from ops import projection_features as pf
from ops import walk_forward

ROOT = Path(__file__).resolve().parent.parent
UNIT = ROOT / "dbt" / "models" / "gold" / "_projection_unit.yml"


def _unit_test(name: str) -> dict[str, Any]:
    tests = yaml.safe_load(UNIT.read_text(encoding="utf-8"))["unit_tests"]
    return next(t for t in tests if t["name"] == name)


def test_lines_are_the_marts_on_its_unit_test_rows() -> None:
    t = _unit_test("projection_features_adjust_the_rates")
    parts = pd.DataFrame(t["given"][0]["rows"])
    for c in pf.PRODUCTION:
        for col in (f"wsum_{c}", f"wsum_other_{c}", f"prior_{c}_pg"):
            if col not in parts:
                parts[col] = np.nan
    settings = t["overrides"]["vars"]["projection_features"]
    expect = {r["player_id"]: r for r in t["expect"]["rows"]}
    for league, rows in parts.groupby("league"):
        got = pf.lines(rows, settings[league])
        for i, pid in enumerate(rows["player_id"]):
            for key, want in expect[pid].items():
                if not key.startswith("proj_") or key.endswith("_pct"):
                    continue
                v = float(got[key.removeprefix("proj_").removesuffix("_pg")][i])
                if want is None:
                    assert math.isnan(v), (pid, key)
                else:
                    assert v == pytest.approx(want, abs=1e-12), (pid, key)


def _parts(n: int, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    df = pd.DataFrame(
        {
            "prior_games": 3.0,
            "prior_minutes": 45.0,
            "proj_minutes_pg": rng.uniform(10, 36, n),
            "rate_weight_cur": rng.uniform(0, 800, n),
            "rate_weight_prev": rng.uniform(0, 600, n),
            "rate_weight_prev2": rng.uniform(0, 200, n),
            "pace_target": rng.uniform(95, 105, n),
            "pace_weight": rng.uniform(100, 1500, n),
            "prior_pace": 99.0,
            "usage_weight": rng.uniform(100, 1500, n),
            "usage_weight_cur": rng.uniform(0, 100, n),
            "prior_usage_rate": 0.17,
            "league_field_goal_pct": 0.47,
            "league_free_throw_pct": 0.78,
        }
    )
    df["rate_weight_other_prev"] = df["rate_weight_prev"] * rng.integers(0, 2, n)
    df["rate_weight_other_prev2"] = 0.0
    df["pace_wsum"] = df["pace_weight"] * rng.uniform(95, 105, n)
    df["usage_wsum"] = df["usage_weight"] * rng.uniform(0.1, 0.3, n)
    df["usage_wsum_cur"] = df["usage_weight_cur"] * rng.uniform(0.1, 0.3, n)
    minutes = df["rate_weight_cur"] + df["rate_weight_prev"] + df["rate_weight_prev2"]
    for c, rate in zip(
        pf.PRODUCTION, (0.5, 0.2, 0.1, 0.03, 0.02, 0.05, 0.06, 0.18, 0.4, 0.08, 0.1), strict=True
    ):
        df[f"wsum_{c}"] = minutes * rate * rng.uniform(0.5, 1.5, n)
        df[f"wsum_other_{c}"] = df["rate_weight_other_prev"] * rate
        df[f"prior_{c}_pg"] = rate * 15
    return df


def test_neutral_is_the_plain_projection() -> None:
    df = _parts(50)
    got = pf.lines(df, pf.NEUTRAL)
    weight = df["rate_weight_cur"] + df["rate_weight_prev"] + df["rate_weight_prev2"] + 45.0
    for c in pf.PRODUCTION:
        plain = (df[f"wsum_{c}"] + 3.0 * df[f"prior_{c}_pg"]) / weight * df["proj_minutes_pg"]
        assert np.allclose(got[c], plain, rtol=0, atol=1e-12)


def test_pace_scales_every_counting_rate_and_keeps_the_percentages() -> None:
    df = _parts(20)
    off, on = pf.lines(df, pf.NEUTRAL), pf.lines(df, {**pf.NEUTRAL, "pace": 1.0})
    ratio = on["points"] / off["points"]
    for c in pf.PRODUCTION:
        assert np.allclose(on[c] / off[c], ratio)
    assert np.allclose(on["fgm"] / on["fga"], off["fgm"] / off["fga"])


def test_usage_moves_only_the_volume_categories() -> None:
    df = _parts(20)
    off, on = pf.lines(df, pf.NEUTRAL), pf.lines(df, {**pf.NEUTRAL, "usage_weight": 4.0})
    assert np.allclose(on["rebounds_total"], off["rebounds_total"])
    assert np.allclose(on["assists"], off["assists"])
    assert not np.allclose(on["points"], off["points"])


def test_shrinkage_pulls_the_percentage_toward_the_league_and_keeps_attempts() -> None:
    df = _parts(20)
    off, on = pf.lines(df, pf.NEUTRAL), pf.lines(df, {**pf.NEUTRAL, "ft_shrink": 1e9})
    assert np.allclose(on["fta"], off["fta"])
    assert np.allclose(on["ftm"] / on["fta"], 0.78)


def test_scoring_matches_the_value_scale_macro() -> None:
    rng = np.random.default_rng(3)
    scale = {c: float(rng.uniform(0.5, 2)) for c in pf.SCALE_COLUMNS}
    line = {c: rng.uniform(0, 20, 30) for c in pf.PRODUCTION}
    con = duckdb.connect()
    con.register("l", pd.DataFrame({f"{c}_pg": v for c, v in line.items()}))
    con.execute("create table s as select " + ", ".join(f"{v} as {k}" for k, v in scale.items()))
    sql_value = con.execute(f"select {walk_forward.score_sql('l', 's')} from l, s").fetchnumpy()
    want = next(iter(sql_value.values()))
    assert np.allclose(pf.total(pf.score(line, scale)), want, atol=1e-12)


def _cut(values: np.ndarray, real: np.ndarray, season: str = "x", cp: float = 0.0) -> pf.Cut:
    return pf.Cut(season, cp, pd.DataFrame(), {}, real, 3)


def test_the_comparison_is_paired_and_pooled() -> None:
    rng = np.random.default_rng(0)
    real = [rng.normal(0, 1, 200) for _ in range(2)]
    cuts = [_cut(np.zeros(200), r) for r in real]
    off = [r + rng.normal(0, 1.0, 200) for r in real]
    on = [r + rng.normal(0, 0.5, 200) for r in real]
    per, pooled = pf.compare(cuts, off, on, resamples=200)
    assert all(g.rmse_gap < 0 for g in per)
    assert pooled.rmse_high < 0 and pooled.spearman_low > 0
    assert pf.passes(per, pooled)[0]
    # the same values both sides move nothing
    per, pooled = pf.compare(cuts, off, off, resamples=50)
    assert pooled.rmse_gap == 0 and pooled.moved == 0
    assert not pf.passes(per, pooled)[0]


def test_a_checkpoint_worse_past_the_tolerance_fails_the_bar() -> None:
    rng = np.random.default_rng(0)
    real = [rng.normal(0, 1, 300) for _ in range(2)]
    cuts = [_cut(np.zeros(300), r) for r in real]
    off = [r + rng.normal(0, 1.0, 300) for r in real]
    # much better at the first, a little worse at the second
    on = [real[0] + rng.normal(0, 0.3, 300), off[1] + 0.5]
    per, pooled = pf.compare(cuts, off, on, resamples=100)
    ok, why = pf.passes(per, pooled)
    assert pooled.rmse_gap < 0 and not ok
    assert any("tolerance" in w for w in why)


def test_the_held_out_season_is_refused(tmp_path: Path) -> None:
    f = tmp_path / "f.csv"
    pd.DataFrame({"league": ["nba"], "season": ["2025-26"], "checkpoint": [0.0]}).to_csv(f)
    with pytest.raises(SystemExit):
        pf.load([f], "nba", 10)


def test_forward_selection_takes_the_feature_that_helps_and_skips_the_one_that_does_not() -> None:
    # a world where realized lines are the pace-scaled projection: pace helps, usage cannot
    df = _parts(300, seed=5)
    truth = pf.lines(df, {**pf.NEUTRAL, "pace": 1.0})
    scale = {c: 1.0 for c in pf.SCALE_COLUMNS} | {"pool": 50.0}
    real = pf.total(pf.score(truth, scale))
    cuts = [pf.Cut("2020-21", 0.0, df, scale, real, 50)]
    steps = pf.forward_order(cuts)
    assert steps[0].feature == "pace" and steps[0].point == {"pace": 1.0}
    assert steps[0].rmse_after < 1e-9 < steps[0].rmse_before
    # nothing else is chosen once the projection is exact: each stays at its neutral point
    assert all(pf.is_neutral(s.point) for s in steps[1:])


def test_parity_fails_when_the_mart_differs(tmp_path: Path) -> None:
    df = _parts(5)
    line = pf.lines(df, pf.NEUTRAL)
    scale = {c: 1.0 for c in pf.SCALE_COLUMNS}
    for c in pf.PRODUCTION:
        df[f"proj_{c}_pg"] = line[c]
    for k, v in scale.items():
        df[f"scale_{k}"] = v
    df["own_value"] = pf.total(pf.score(line, scale))
    pf.check_parity(df, pf.NEUTRAL, "test")
    df.loc[0, "proj_points_pg"] += 0.01
    with pytest.raises(SystemExit):
        pf.check_parity(df, pf.NEUTRAL, "test")


def _build(
    df: pd.DataFrame, s: dict[str, float], scale: dict[str, float], build: str
) -> pd.DataFrame:
    out = df.copy()
    line = pf.lines(df, s)
    for c in pf.PRODUCTION:
        out[f"proj_{c}_pg"] = line[c]
    for k, v in scale.items():
        out[f"scale_{k}"] = v
    out["own_value"] = out["board_value"] = pf.total(pf.score(line, scale))
    return out.assign(build=build)


def test_the_confirmation_reproduces_the_declared_measure_on_the_off_scale(tmp_path: Path) -> None:
    rng = np.random.default_rng(2)
    df = _parts(60, seed=4).assign(
        league="wnba", season="2024", checkpoint=0.0, player_id=[f"p{i}" for i in range(60)]
    )
    df["realized_games"] = 20
    for c in pf.PRODUCTION:
        df[f"real_{c}_pg"] = pf.lines(df, pf.NEUTRAL)[c] * rng.uniform(0.7, 1.3, 60)
    setting = {**pf.NEUTRAL, "fg_shrink": 50.0}
    off_scale = {c: 1.0 for c in pf.SCALE_COLUMNS} | {"pool": 10.0}
    # the on build's own scale is narrower in shooting, as a shrinkage makes it
    on_scale = off_scale | {"sd_fg_impact": 0.8}
    f = tmp_path / "f.csv"
    pd.concat(
        [_build(df, pf.NEUTRAL, off_scale, "off"), _build(df, setting, on_scale, "on")]
    ).to_csv(f, index=False)
    found = pf.confirm([f], "wnba", setting, 10, 50)
    assert found["parity"]["worst_value_gap"] < 1e-12
    assert found["built_off_scale"][1].rmse_gap == pytest.approx(found["declared"][1].rmse_gap)
    assert found["parity"]["scale_on_over_off"][0]["sd_fg_impact"] == pytest.approx(0.8)
    # on its own scale the on build is judged in other units, so the figure differs
    assert found["built_own_scale"][1].rmse_gap != pytest.approx(found["declared"][1].rmse_gap)
