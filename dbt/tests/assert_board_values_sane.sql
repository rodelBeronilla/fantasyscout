{{ config(severity='error', tags=['quality', 'board']) }}

-- Every board row has played games behind its projection, season weights that with the
-- replacement-level prior add up to one, a multiplier and a rest-of-season factor between 0
-- and 1, a games share between 0 and 1, and season and rest-of-season values no larger in
-- magnitude than the values they scale.
select league, player_id, sample_weight, w_cur, w_prev, w_prev2, w_prior, availability_multiplier, ros_factor,
    games_share, value_per_game, value_total, value_rest_of_season
from {{ ref('mart_board') }}
where coalesce(sample_weight, 0) <= 0
    or abs(coalesce(w_cur, 0) + coalesce(w_prev, 0) + coalesce(w_prev2, 0) + coalesce(w_prior, 0) - 1) > 0.000001
    or availability_multiplier < 0 or availability_multiplier > 1
    or ros_factor < 0 or ros_factor > 1
    or games_share <= 0 or games_share > 1
    or abs(value_total) > abs(value_per_game) + 0.000001
    or abs(value_rest_of_season) > abs(value_total) + 0.000001
