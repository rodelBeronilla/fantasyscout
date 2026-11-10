{{ config(severity='error', tags=['quality', 'closure']) }}

-- The player rows of a team-game add up to the team row for every counting stat except
-- turnovers: the team total includes team turnovers (shot-clock and 8-second violations,
-- inbound violations) that belong to no player, so turnovers are checked separately
-- (warn_team_turnovers). A row that fails usually means the league corrected a stat after the
-- game's box score settled: the season game log (the team row) is landed again every day, the
-- box score (the player rows) is not. The ingestor fetches such a game again by itself, and
-- the `differs` column names the stats that moved.
{% set closed = [
    'points', 'field_goals_made', 'field_goals_attempted', 'three_pointers_made',
    'three_pointers_attempted', 'free_throws_made', 'free_throws_attempted', 'rebounds_offensive',
    'rebounds_defensive', 'rebounds_total', 'assists', 'steals', 'blocks', 'fouls_personal',
] %}
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
        sum(fouls_personal) as fouls_personal,
        -- sum() skips nulls, so a nulled column would shrink a side silently; count them instead
        sum(case when played and (points is null or field_goals_made is null or field_goals_attempted is null or three_pointers_made is null or three_pointers_attempted is null or free_throws_made is null or free_throws_attempted is null or rebounds_offensive is null or rebounds_defensive is null or rebounds_total is null or assists is null or steals is null or blocks is null or turnovers is null or fouls_personal is null) then 1 else 0 end) as null_stats
    from {{ ref('fct_player_game') }}
    group by league, game_id, team_id

)

select
    t.team_game_key,
    concat_ws(
        ', ',
        {%- for stat in closed %}
        case when t.{{ stat }} <> p.{{ stat }} then concat('{{ stat }}: team ', cast(t.{{ stat }} as string), ', players ', cast(p.{{ stat }} as string)) end{{ ',' if not loop.last }}
        {%- endfor %}
    ) as differs,
    t.points as team_points, p.points as player_points,
    t.rebounds_total as team_rebounds, p.rebounds_total as player_rebounds,
    t.assists as team_assists, p.assists as player_assists,
    t.turnovers as team_turnovers, p.turnovers as player_turnovers
from {{ ref('fct_team_game') }} as t
join player_sums as p
    on p.league = t.league and p.game_id = t.game_id and p.team_id = t.team_id
where p.null_stats > 0
    or t.points is null or t.rebounds_total is null or t.assists is null or t.turnovers is null
    {%- for stat in closed %}
    or t.{{ stat }} <> p.{{ stat }}
    {%- endfor %}
