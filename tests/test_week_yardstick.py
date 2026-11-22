"""S0's yardstick (#1077): the week's categories, the population, the errors and the noise."""

from __future__ import annotations

from datetime import date

import numpy as np

from ops import week_yardstick as wy


def test_a_week_counts_games_and_scores_percentages_at_the_real_attempts() -> None:
    # one player: 20 pts, 5 reb, 4 ast, 1 stl, 1 blk, 2 3pm, 3 to; 8 of 16 FG, 4 of 5 FT
    per_game = np.array([[20, 5, 4, 1, 1, 2, 3, 8, 16, 4, 5]], dtype=float)
    real = np.array([[70, 18, 10, 2, 3, 9, 8, 26, 60, 15, 20]], dtype=float)
    week = wy.category_weeks(per_game, np.array([3.0]), real)
    assert week[0, :7].tolist() == [60, 15, 12, 3, 3, 6, 9]
    # 50% at the real 60 attempts is 30 makes; 80% at the real 20 free throws is 16
    assert week[0, 7] == 30.0
    assert week[0, 8] == 16.0
    assert wy.real_weeks(real)[0].tolist() == [70, 18, 10, 2, 3, 9, 8, 26, 15]
    # no attempts projected: the rate is zero, not a division error
    assert wy.category_weeks(np.zeros((1, 11)), np.array([2.0]), real)[0, 7] == 0.0


def test_the_population_is_the_top_of_the_board_among_players_with_a_game() -> None:
    value = np.array([5.0, 9.0, 7.0, 8.0, 1.0])
    scheduled = np.array([3, 0, 2, 4, 1])
    # the second player has no game this week: left out, whatever his value
    assert wy.population(value, scheduled, pool=2).tolist() == [3, 2]
    assert wy.population(value, scheduled, pool=10).tolist() == [3, 2, 0, 4]


def test_judge_reports_each_category_with_its_noise_and_the_bar_a_quarter_of_it() -> None:
    rng = np.random.default_rng(1)
    weeks = []
    for k in range(6):
        real = rng.normal(10, 3, (40, 9))
        weeks.append(
            wy.Week(
                as_of=date(2022, 1, 3 + 7 * (k % 3)),
                proj=real + rng.normal(0, 1, real.shape),
                naive=real + rng.normal(0, 2, real.shape),
                real=real,
            )
        )
    cats = wy.judge(weeks, resamples=200, seeds=3)
    assert [c.category for c in cats] == list(wy.CATEGORIES)
    for c in cats:
        # the projection's error (1) is half the naive manager's (2): clearly below zero
        assert 0.8 < c.rmse_projection < 1.2
        assert 1.7 < c.rmse_naive < 2.3
        assert c.diff_high < 0
        assert c.bar == c.noise / 4
        assert c.seed_noise_min <= c.noise <= c.seed_noise_max
