{# One row per calendar date from the first backfilled season through 2030. #}

with spine as (

    {{ date_spine('2018-01-01', '2030-12-31') }}

),

game_days as (

    select league, game_date
    from {{ ref('games') }}
    group by league, game_date

)

select
    spine.date_day,
    {{ sk(['spine.date_day']) }} as date_sk,
    year(spine.date_day) as year,
    month(spine.date_day) as month,
    {{ iso_dow('spine.date_day') }} as iso_day_of_week,
    {{ week_start('spine.date_day') }} as week_start,
    -- Fantasy weeks run Monday to Sunday, numbered within the calendar year of the Monday.
    cast(year({{ week_start('spine.date_day') }}) as string) || '-W'
        || lpad(cast(cast(({{ days_between("cast(year(" ~ week_start('spine.date_day') ~ ") || '-01-01' as date)", week_start('spine.date_day')) }} / 7) + 1 as integer) as string), 2, '0') as fantasy_week,
    wnba.game_date is not null as is_game_day_wnba,
    nba.game_date is not null as is_game_day_nba
from spine
left join game_days as wnba on wnba.league = 'wnba' and wnba.game_date = spine.date_day
left join game_days as nba on nba.league = 'nba' and nba.game_date = spine.date_day
