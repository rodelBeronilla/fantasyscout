{{ config(severity='error', tags=['quality', 'board']) }}

-- Every board row has a played season among the three blended, a multiplier between 0 and 1,
-- and a rest-of-season value no larger in magnitude than the blend it scales.
select league, player_id, w_cur, w_prev, w_prev2, availability_multiplier, value_total, value_rest_of_season
from {{ ref('mart_board') }}
where coalesce(w_cur, 0) + coalesce(w_prev, 0) + coalesce(w_prev2, 0) = 0
    or availability_multiplier < 0 or availability_multiplier > 1
    or abs(value_rest_of_season) > abs(value_total) + 0.000001
