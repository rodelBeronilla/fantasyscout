{{ config(severity='warn', tags=['quality', 'closure']) }}

-- Team turnovers are the players' turnovers plus team turnovers (no player charged), so the
-- team figure must be at least the players' sum and rarely more than a handful above it.
with player_sums as (

    select league, game_id, team_id, sum(turnovers) as turnovers
    from {{ ref('fct_player_game') }}
    group by league, game_id, team_id

)

select
    t.team_game_key,
    t.turnovers as team_turnovers,
    p.turnovers as player_turnovers,
    t.turnovers - p.turnovers as team_only_turnovers
from {{ ref('fct_team_game') }} as t
join player_sums as p
    on p.league = t.league and p.game_id = t.game_id and p.team_id = t.team_id
where t.turnovers < p.turnovers
    or t.turnovers - p.turnovers > 8
