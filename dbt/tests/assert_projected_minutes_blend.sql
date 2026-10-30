{{ config(severity='error', tags=['board']) }}

-- Projected minutes are the season-weighted figure, or in season a blend of it with the last
-- five games (var fantasy_recent_minutes): never outside the two.
select league, player_id, proj_minutes_pg, proj_minutes_season_pg, minutes_last5_pg
from {{ ref('mart_player_projection') }}
where proj_minutes_pg < least(proj_minutes_season_pg, coalesce(minutes_last5_pg, proj_minutes_season_pg)) - 0.000001
    or proj_minutes_pg > greatest(proj_minutes_season_pg, coalesce(minutes_last5_pg, proj_minutes_season_pg)) + 0.000001
