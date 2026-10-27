{{ config(severity='warn', tags=['quality', 'shots']) }}

-- Court coordinates inside the half court (tenths of a foot from the basket) and the
-- three-point flag consistent with distance: a three is at least 21 feet out, a two at most 24.
select
    shot_key,
    loc_x,
    loc_y,
    shot_distance,
    is_three,
    shot_zone_basic
from {{ ref('fct_shot') }}
where loc_x < -250 or loc_x > 250
    or loc_y < -52 or loc_y > 890
    or (is_three and shot_distance < 21)
    or (not is_three and shot_distance > 24)
