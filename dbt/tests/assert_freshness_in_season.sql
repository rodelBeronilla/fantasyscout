{{ config(severity='error', tags=['quality', 'freshness']) }}

-- In season, the latest game in gold is within 36 hours of the last completed scheduled game.
-- Out of season (no completed scheduled game in the last 14 days) there is nothing to check.
with last_scheduled as (

    select league, max(game_date_est) as last_final_date
    from {{ ref('schedule') }}
    where game_status = 3
        and game_type in ('regular', 'playoffs')  -- preseason is not ingested (SPEC.md scope)
        and game_date_est < {{ as_of_date() }}
    group by league

),

last_in_gold as (

    select league, max(game_date) as last_game_date
    from {{ ref('fct_player_game') }}
    group by league

)

select
    s.league,
    s.last_final_date,
    g.last_game_date,
    {{ days_between('g.last_game_date', 's.last_final_date') }} as days_behind
from last_scheduled as s
left join last_in_gold as g on g.league = s.league
where {{ days_between('s.last_final_date', as_of_date()) }} <= 14
    and (g.last_game_date is null or {{ days_between('g.last_game_date', 's.last_final_date') }} > 1)
