"""The walk-forward harness scores like the lakehouse, cuts where it says, and keeps the held-out
season locked (#796)."""

from __future__ import annotations

from datetime import date

import duckdb
import numpy as np
import pandas as pd

from ops import walk_forward
from ops.walk_forward import checkpoints, judge, score_sql


def test_scoring_matches_the_value_scale_macro() -> None:
    # every_window_is_on_the_season_scale's figures: 25 points and 6 of 10 is 1.1 above replacement
    con = duckdb.connect()
    cats = list(walk_forward.COUNTING)
    con.execute(
        "create table s as select 20.0 as mean_points, 5.0 as sd_points,"
        " 0.5 as pool_field_goal_pct, 2.0 as sd_fg_impact,"
        " 0.0 as pool_free_throw_pct, null::double as sd_ft_impact, "
        + ", ".join(f"0.4 as repl_z_{c}" if c == "points" else f"0.0 as repl_z_{c}" for c in cats)
        + ", 0.0 as repl_z_field_goal_pct, 0.0 as repl_z_free_throw_pct, "
        + ", ".join(
            f"null::double as mean_{c}, null::double as sd_{c}" for c in cats if c != "points"
        )
    )
    con.execute(
        "create table l as select 25.0 as points_pg, 6.0 as fgm_pg, 10.0 as fga_pg,"
        " 0.0 as ftm_pg, 0.0 as fta_pg, "
        + ", ".join(f"0.0 as {c}_pg" for c in cats if c != "points")
    )
    row = con.execute(f"select {score_sql('l', 's')} from l, s").fetchone()
    assert row is not None and abs(row[0] - 1.1) < 1e-9


def test_checkpoints_are_the_first_day_and_shares_of_the_season() -> None:
    days = checkpoints(date(2024, 10, 22), date(2025, 4, 13), [0.0, 0.1, 0.25, 0.5])
    assert days == [date(2024, 10, 22), date(2024, 11, 8), date(2024, 12, 4), date(2025, 1, 16)]


def test_a_checkpoint_is_judged_on_the_players_who_then_played() -> None:
    real = np.linspace(-2, 3, 40)
    df = pd.DataFrame(
        {
            "player_id": [f"p{i}" for i in range(42)],
            "board_value": [*(real + 0.1), 5.0, 5.0],
            "naive_value": [*real[::-1], 5.0, 5.0],
            "realized_value": [*real, 9.0, 9.0],
            "realized_games": [20] * 40 + [3, 0],
            "pool": [10] * 42,
        }
    )
    cp = judge(df, date(2025, 1, 1), min_games=10, resamples=200)
    assert cp.players == 40, "the two with fewer games are not judged"
    assert abs(cp.rmse_board - 0.1) < 1e-9 and cp.rmse_naive > 1
    assert cp.spearman_board > 0.99 and cp.spearman_naive < -0.99
    assert cp.top_pool_board == 1.0 and cp.top_pool_naive == 0.0
    assert cp.rmse_gap_high < 0, "the board beats the naive manager with room to spare"


def test_the_held_out_season_is_refused_without_its_one_judgement() -> None:
    assert walk_forward.main(["--league", "nba", "--season", "2025-26"]) == 2
    assert walk_forward.main(["--league", "wnba", "--season", "2026"]) == 2
