{{ config(severity='error', tags=['quality', 'arithmetic']) }}

-- Basketball arithmetic on every player-game that was played:
-- PTS = 2*FGM + FG3M + FTM, FGM <= FGA, FG3M <= FGM, FG3A <= FGA, FTM <= FTA, REB = OREB + DREB.
-- A counting stat that is null on a played row fails too: a comparison with a null operand is
-- never true, so without this a source that renamed or dropped a column would pass every
-- arithmetic check while the board's values moved (#383).
select
    player_game_key,
    points,
    field_goals_made,
    three_pointers_made,
    free_throws_made,
    rebounds_total,
    rebounds_offensive,
    rebounds_defensive
from {{ ref('fct_player_game') }}
where played
    and (
        points <> 2 * field_goals_made + three_pointers_made + free_throws_made
        or field_goals_made > field_goals_attempted
        or three_pointers_made > field_goals_made
        or three_pointers_attempted > field_goals_attempted
        or free_throws_made > free_throws_attempted
        or rebounds_total <> rebounds_offensive + rebounds_defensive
        or minutes is null
        or points is null
        or field_goals_made is null
        or field_goals_attempted is null
        or three_pointers_made is null
        or three_pointers_attempted is null
        or free_throws_made is null
        or free_throws_attempted is null
        or rebounds_offensive is null
        or rebounds_defensive is null
        or rebounds_total is null
        or assists is null
        or steals is null
        or blocks is null
        or turnovers is null
        or fouls_personal is null
    )
