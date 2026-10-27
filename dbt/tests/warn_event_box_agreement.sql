{{ config(severity='warn', tags=['quality', 'agreement']) }}

-- Made field goals in play-by-play per player-game equal FGM in the box score.
with made_in_events as (

    select league, game_id, player_id, count(*) as made_shots
    from {{ ref('fct_event') }}
    where is_field_goal and shot_result = 'Made'
    group by league, game_id, player_id

),

box as (

    select league, game_id, player_id, field_goals_made
    from {{ ref('fct_player_game') }}
    where played

)

select
    box.league,
    box.game_id,
    box.player_id,
    box.field_goals_made,
    coalesce(e.made_shots, 0) as made_shots_in_events
from box
join (select league, game_id from {{ ref('fct_event') }} group by league, game_id) as has_events
    on has_events.league = box.league and has_events.game_id = box.game_id
left join made_in_events as e
    on e.league = box.league and e.game_id = box.game_id and e.player_id = box.player_id
where box.field_goals_made <> coalesce(e.made_shots, 0)
