{{ config(severity='error', tags=['quality', 'arithmetic']) }}

-- Basketball arithmetic on every player-game that was played:
-- PTS = 2*FGM + FG3M + FTM, FGM <= FGA, FG3M <= FGM, FG3A <= FGA, FTM <= FTA, REB = OREB + DREB.
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
    )
