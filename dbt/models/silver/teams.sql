{# One row per team per season seen in the game log, enriched from the teams seed. #}

with seen as (

    select
        league,
        season,
        team_id,
        team_abbreviation,
        team_name,
        max(_ingest_date) as _ingest_date
    from {{ ref('stats_leaguegamelog') }}
    where team_id is not null
    group by league, season, team_id, team_abbreviation, team_name

)

select
    seen.league,
    seen.season,
    seen.team_id,
    seen.league || ':' || seen.season || ':' || seen.team_id as team_season_key,
    seen.team_abbreviation as abbreviation,
    seen.team_name,
    seed.name,
    seed.city,
    seed.conference,
    seed.note,
    seen._ingest_date
from seen
left join {{ ref('team_reference') }} as seed
    on seed.league = seen.league and seed.abbreviation = seen.team_abbreviation
