{#
  Each player's role in today's game from the league's starting lineups (NBA only): starter,
  bench or inactive, and whether the team has confirmed it. The board and Streamers show it
  next to the player. Only the latest game day on or after the build date counts.
#}

with today as (

    select *
    from {{ ref('starting_lineups') }}
    where game_date >= {{ as_of_date() }}
    qualify game_date = min(game_date) over (partition by league)

)

select
    {{ sk(['league', 'game_id', 'player_id']) }} as starting_lineup_sk,
    league,
    season,
    game_date,
    game_id,
    team_id,
    player_id,
    case when is_inactive then 'inactive' when is_starter then 'starter' else 'bench' end as lineup_role,
    is_confirmed,
    position as starting_position,
    updated_at
from today
