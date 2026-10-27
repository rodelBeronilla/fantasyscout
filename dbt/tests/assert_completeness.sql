{{ config(severity='error', tags=['quality', 'completeness']) }}

-- Every final regular-season or playoff game on the schedule that finished more than a day
-- ago has a box score and play-by-play in gold. Preseason, All-Star, play-in and tournament
-- finals are on the schedule but outside what the ingestors fetch (SPEC.md scope), so they
-- are not counted as missing.
with final_games as (

    select league, season, game_id, game_date_est, game_type
    from {{ ref('schedule') }}
    where game_status = 3
        and game_type in ('regular', 'playoffs')
        and game_date_est < {{ add_days(as_of_date(), -1) }}

),

with_box as (

    select league, game_id from {{ ref('fct_player_game') }} group by league, game_id

),

with_pbp as (

    select league, game_id from {{ ref('fct_event') }} group by league, game_id

)

select
    f.league,
    f.season,
    f.game_id,
    f.game_type,
    f.game_date_est,
    b.game_id is not null as has_box_score,
    p.game_id is not null as has_play_by_play
from final_games as f
left join with_box as b on b.league = f.league and b.game_id = f.game_id
left join with_pbp as p on p.league = f.league and p.game_id = f.game_id
where b.game_id is null or p.game_id is null
