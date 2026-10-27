{{ config(severity='warn', tags=['quality', 'closure']) }}

-- Player minutes per team-game add up to the team minutes (200 WNBA / 240 NBA, +25 per
-- overtime) within one minute.
with player_minutes as (

    select league, game_id, team_id, sum(minutes) as minutes
    from {{ ref('fct_player_game') }}
    group by league, game_id, team_id

)

select
    t.team_game_key,
    t.team_minutes,
    p.minutes as player_minutes,
    t.team_minutes - p.minutes as difference
from {{ ref('fct_team_game') }} as t
join player_minutes as p
    on p.league = t.league and p.game_id = t.game_id and p.team_id = t.team_id
where abs(t.team_minutes - p.minutes) > 1.0
