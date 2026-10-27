{# One row per ESPN event with the two competitors unpacked. Latest landing wins. #}

with events as (

    select *
    from {{ ref('espn_scoreboard') }}
    where event_id is not null
    qualify row_number() over (partition by league, event_id order by _ingest_date desc, _source_file desc) = 1

)

select
    league,
    season,
    event_id,
    league || ':' || event_id as event_key,
    cast(substr(event_date, 1, 10) as date) as event_date,
    event_date as event_datetime_utc,
    name,
    short_name,
    try_cast(season_year as integer) as season_year,
    try_cast(season_type as integer) as season_type,
    status_state,
    cast(status_completed as boolean) as completed,
    competition_id,
    cast(neutral_site as boolean) as neutral_site,
    venue_name,
    case when {{ json_text('competitors', '$[0].homeAway') }} = 'home'
        then {{ json_text('competitors', '$[0].team.id') }} else {{ json_text('competitors', '$[1].team.id') }} end as home_team_id,
    case when {{ json_text('competitors', '$[0].homeAway') }} = 'home'
        then {{ json_text('competitors', '$[1].team.id') }} else {{ json_text('competitors', '$[0].team.id') }} end as away_team_id,
    case when {{ json_text('competitors', '$[0].homeAway') }} = 'home'
        then try_cast({{ json_text('competitors', '$[0].score') }} as integer) else try_cast({{ json_text('competitors', '$[1].score') }} as integer) end as home_score,
    case when {{ json_text('competitors', '$[0].homeAway') }} = 'home'
        then try_cast({{ json_text('competitors', '$[1].score') }} as integer) else try_cast({{ json_text('competitors', '$[0].score') }} as integer) end as away_score,
    _ingest_date,
    _source_file
from events
