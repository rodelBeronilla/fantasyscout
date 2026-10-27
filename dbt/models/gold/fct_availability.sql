{#
  Player × report day from ESPN's injury report. ESPN does not carry the stats API player id
  in this feed, so the row carries ESPN's name and team until the phase 4 crosswalk links it.
#}

select
    {{ sk(['league', "cast(report_date as varchar)", 'injury_id']) }} as availability_sk,
    league,
    season,
    report_date,
    injury_id,
    team_id as espn_team_id,
    team_name,
    athlete_id as espn_player_id,
    athlete_name,
    cast(null as varchar) as stats_player_id,
    status,
    case
        when lower(status) = 'out' then 'out'
        when lower(status) like 'day%' then 'day_to_day'
        when lower(status) like '%question%' then 'questionable'
        when lower(status) like '%doubt%' then 'doubtful'
        else 'other'
    end as status_group,
    injury_type,
    return_date as expected_return,
    reported_date,
    'espn' as source,
    _ingest_date
from {{ ref('injuries') }}
