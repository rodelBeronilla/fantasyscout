{{ config(severity='error', tags=['quality', 'player']) }}

-- A player's stints follow one another: each ends the day before the next begins and only the
-- last is open. A game joined to the stint whose dates contain it would otherwise fan out.
with ordered as (

    select
        league,
        stats_player_id,
        team_id,
        valid_from,
        valid_to,
        lead(valid_from) over (partition by league, stats_player_id order by valid_from) as next_valid_from
    from {{ ref('dim_player') }}

)

select league, stats_player_id, team_id, valid_from, valid_to, next_valid_from
from ordered
where next_valid_from is not null
    and (valid_to is null or valid_to <> {{ add_days('next_valid_from', -1) }})
