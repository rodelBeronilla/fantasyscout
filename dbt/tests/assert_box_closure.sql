{{ config(severity='error', tags=['quality', 'closure']) }}

-- The player rows of a team-game add up to the team row for every counting stat except
-- turnovers: the team total includes team turnovers (shot-clock and 8-second violations,
-- inbound violations) that belong to no player, so turnovers are checked separately
-- (warn_team_turnovers).
with player_sums as (

    select
        league,
        game_id,
        team_id,
        sum(points) as points,
        sum(field_goals_made) as field_goals_made,
        sum(field_goals_attempted) as field_goals_attempted,
        sum(three_pointers_made) as three_pointers_made,
        sum(three_pointers_attempted) as three_pointers_attempted,
        sum(free_throws_made) as free_throws_made,
        sum(free_throws_attempted) as free_throws_attempted,
        sum(rebounds_offensive) as rebounds_offensive,
        sum(rebounds_defensive) as rebounds_defensive,
        sum(rebounds_total) as rebounds_total,
        sum(assists) as assists,
        sum(steals) as steals,
        sum(blocks) as blocks,
        sum(turnovers) as turnovers,
        sum(fouls_personal) as fouls_personal
    from {{ ref('fct_player_game') }}
    group by league, game_id, team_id

)

select
    t.team_game_key,
    t.points as team_points, p.points as player_points,
    t.rebounds_total as team_rebounds, p.rebounds_total as player_rebounds,
    t.assists as team_assists, p.assists as player_assists,
    t.turnovers as team_turnovers, p.turnovers as player_turnovers
from {{ ref('fct_team_game') }} as t
join player_sums as p
    on p.league = t.league and p.game_id = t.game_id and p.team_id = t.team_id
where t.points <> p.points
    or t.field_goals_made <> p.field_goals_made
    or t.field_goals_attempted <> p.field_goals_attempted
    or t.three_pointers_made <> p.three_pointers_made
    or t.three_pointers_attempted <> p.three_pointers_attempted
    or t.free_throws_made <> p.free_throws_made
    or t.free_throws_attempted <> p.free_throws_attempted
    or t.rebounds_offensive <> p.rebounds_offensive
    or t.rebounds_defensive <> p.rebounds_defensive
    or t.rebounds_total <> p.rebounds_total
    or t.assists <> p.assists
    or t.steals <> p.steals
    or t.blocks <> p.blocks
    or t.fouls_personal <> p.fouls_personal
