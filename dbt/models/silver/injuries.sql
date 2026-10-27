{# One row per injury listing (ESPN is the only injury source), typed. Latest landing wins. #}

select
    league,
    season,
    injury_id,
    league || ':' || injury_id as injury_key,
    team_id,
    team_name,
    athlete_id,
    athlete_name,
    status,
    cast(substr(reported_at, 1, 10) as date) as reported_date,
    injury_type,
    return_date,
    fantasy_status,
    short_comment,
    long_comment,
    cast(substr(report_timestamp, 1, 10) as date) as report_date,
    _ingest_date,
    _source_file
from {{ ref('espn_injuries') }}
where injury_id is not null
qualify row_number() over (partition by league, injury_id order by _ingest_date desc, _source_file desc) = 1
