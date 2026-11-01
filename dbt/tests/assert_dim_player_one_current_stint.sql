{{ config(severity='error', tags=['quality', 'player']) }}

-- Every player has exactly one current stint in dim_player: one row with is_current and one with
-- valid_to null, the same row. The board, the streamers and the status models join a player to
-- their current stint and would double the player otherwise.
select
    league,
    stats_player_id,
    sum(case when is_current then 1 else 0 end) as current_stints,
    sum(case when valid_to is null then 1 else 0 end) as open_stints
from {{ ref('dim_player') }}
group by league, stats_player_id
having sum(case when is_current then 1 else 0 end) <> 1
    or sum(case when valid_to is null then 1 else 0 end) <> 1
    or sum(case when is_current and valid_to is null then 1 else 0 end) <> 1
