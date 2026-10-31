{{ config(severity='error', tags=['board']) }}

-- Projected minutes are the season-weighted figure, or in season a blend of it with the last
-- five games (var fantasy_recent_minutes): never outside the two once the return ramp's cut
-- (var fantasy_return_ramp) is taken back out. The ramp keeps between 1 - max_cut and all of them.
{% set ramp = var('fantasy_return_ramp') %}
select league, player_id, proj_minutes_pg, proj_minutes_season_pg, minutes_last5_pg, return_minutes_factor
from {{ ref('mart_player_projection') }}
where proj_minutes_pg / return_minutes_factor < least(proj_minutes_season_pg, coalesce(minutes_last5_pg, proj_minutes_season_pg)) - 0.000001
    or proj_minutes_pg / return_minutes_factor > greatest(proj_minutes_season_pg, coalesce(minutes_last5_pg, proj_minutes_season_pg)) + 0.000001
    or return_minutes_factor < 1 - {{ ramp['max_cut'] }} - 0.000001
    or return_minutes_factor > 1
