"""The helpers the notebooks share (notebooks/boxscore.py, #484, #776): the build's own value scale
read off its scored lines, and the statistics."""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "notebooks"))
import boxscore

DBT_DB = Path(__file__).resolve().parent.parent / "dbt" / "fantasyscout.duckdb"


def test_ols_recovers_a_line_and_weights_rows() -> None:
    x = np.c_[np.ones(4), np.array([0.0, 1.0, 2.0, 3.0])]
    y = np.array([1.0, 3.0, 5.0, 7.0])
    assert boxscore.ols(x, y) == pytest.approx([1.0, 2.0])
    # a zero weight drops a row: the outlier stops pulling the fit
    y_out = np.array([1.0, 3.0, 5.0, 70.0])
    assert boxscore.ols(x, y_out, np.array([1.0, 1.0, 1.0, 0.0])) == pytest.approx([1.0, 2.0])


def test_finished_keeps_the_latest_season_only_once_it_has_playoffs() -> None:
    seasons = pd.DataFrame({"season": ["2023", "2024", "2025"], "regular": [True, True, True]})
    assert boxscore.finished(seasons) == ["2023", "2024"]
    with_playoffs = pd.concat([seasons, pd.DataFrame({"season": ["2025"], "regular": [False]})])
    assert boxscore.finished(with_playoffs) == ["2023", "2024", "2025"]


def test_rank_metrics() -> None:
    assert list(boxscore.average_rank(np.array([3.0, 1.0, 3.0, 2.0]))) == [3.5, 1.0, 3.5, 2.0]
    x = np.arange(10.0)
    assert boxscore.spearman(x, x**3) == pytest.approx(1.0)
    assert boxscore.top_hits(x, x, 3) == 1.0
    assert boxscore.top_hits(x, -x, 3) == 0.0
    assert boxscore.top_hits(x, np.where(x > 7, np.nan, x), 2) == 0.0


def test_lines_count_a_missing_number_in_a_game_played_as_zero() -> None:
    rows = pd.DataFrame(
        {
            "player_id": ["a", "a", "b"],
            "played": [True, True, False],
            "minutes": [30.0, 20.0, 0.0],
            **{c: [2.0, np.nan, 9.0] for c in (*boxscore.COUNTING, *boxscore.BOX)},
        }
    )
    ln = boxscore.lines(rows)
    assert list(ln.index) == ["a"]
    assert ln.loc["a", "points_pg"] == 1.0
    assert ln.loc["a", "total_minutes"] == 50.0


def _scored(lines: pd.DataFrame) -> pd.DataFrame:
    """mart_category_zscores' season rows on a known scale, as macros/value_scale.sql scores."""
    out = lines.copy()
    mean, sd, repl = 10.0, 4.0, 0.25
    for c in boxscore.COUNTING:
        z = (lines[f"{c}_pg"] - mean) / sd
        out[f"z_{c}"] = (-z if c == "turnovers" else z) - repl
    shooting = (("field_goal_pct", "fga", 0.45, 1.5), ("free_throw_pct", "fta", 0.8, 0.5))
    for name, att, pct, spread in shooting:
        makes = lines[name].fillna(0) * lines[f"{att}_pg"]
        out[f"z_{name}"] = (makes - pct * lines[f"{att}_pg"]) / spread - repl
    return out


def test_value_scale_reads_the_scale_off_the_scored_lines() -> None:
    rng = np.random.default_rng(1)
    n = 40
    ln = pd.DataFrame({f"{c}_pg": rng.uniform(0, 25, n) for c in boxscore.COUNTING})
    ln["fga_pg"] = rng.uniform(0, 20, n)
    ln["fta_pg"] = rng.uniform(0, 8, n)
    ln.loc[0, ["fga_pg", "fta_pg"]] = 0.0  # no attempts: no percentage
    ln["field_goal_pct"] = np.where(ln["fga_pg"] > 0, rng.uniform(0.3, 0.6, n), np.nan)
    ln["free_throw_pct"] = np.where(ln["fta_pg"] > 0, rng.uniform(0.5, 0.95, n), np.nan)
    table = _scored(ln).assign(window_name="season", league="nba", season="2024-25")
    con = duckdb.connect()
    con.register("mart_category_zscores", table)
    scale = boxscore.value_scale(con, "nba")["2024-25"]
    assert scale["counting"]["points"] == pytest.approx(0.25)
    assert scale["counting"]["turnovers"] == pytest.approx(-0.25)
    w_made, w_att = scale["shooting"]["field_goal_pct"]
    assert (w_made, -w_att / w_made) == pytest.approx((1 / 1.5, 0.45))
    # an empty line: each category's (0 - mean) / sd less replacement, turnovers the other way
    assert scale["base"] == pytest.approx(6 * -2.5 + 2.5 - 9 * 0.25)
    # a line scored on it is the build's z_total
    pg = ln.assign(fgm_pg=ln["field_goal_pct"].fillna(0) * ln["fga_pg"])
    pg["ftm_pg"] = ln["free_throw_pct"].fillna(0) * ln["fta_pg"]
    z_total = table[[c for c in table if c.startswith("z_")]].sum(axis=1)
    assert boxscore.line_value(pg, scale).to_numpy() == pytest.approx(z_total.to_numpy())


@pytest.mark.skipif(not DBT_DB.exists(), reason="dbt sample not built")
def test_value_scale_scores_every_window_as_the_build_does_on_the_sample() -> None:
    """Read off the season lines, the scale reproduces z_total for every window and season, and
    each counting weight is one over int_value_scale's spread where the sample has one."""
    con = duckdb.connect(str(DBT_DB), read_only=True)
    try:
        con.sql("use gold")
        checked = 0
        for league in ("nba", "wnba"):
            scales = boxscore.value_scale(con, league)
            mart = con.sql(f"select * from mart_category_zscores where league = '{league}'").df()
            for season, scale in scales.items():
                part = mart[mart["season"] == season]
                pg = part.assign(
                    fgm_pg=part["field_goal_pct"].astype(float).fillna(0) * part["fga_pg"],
                    ftm_pg=part["free_throw_pct"].astype(float).fillna(0) * part["fta_pg"],
                )
                got = boxscore.line_value(pg, scale).to_numpy(float)
                assert got == pytest.approx(part["z_total"].to_numpy(float), abs=1e-9)
                checked += len(part)
                s = con.sql(
                    "select * from int_value_scale where league = ? and season = ?",
                    params=[league, season],
                ).df()
                for c in boxscore.COUNTING:
                    sd = s[f"sd_{c}"].iloc[0]
                    if pd.notna(sd) and sd > 0:
                        sign = -1 if c == "turnovers" else 1
                        assert scale["counting"][c] == pytest.approx(sign / sd, rel=1e-6)
        assert checked, "the sample has no scored season"
    finally:
        con.close()
