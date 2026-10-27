{# One row per ESPN team per league from the teams endpoint. Latest landing wins. #}

select
    league,
    team_id,
    league || ':' || team_id as espn_team_key,
    abbreviation,
    display_name,
    location,
    name as nickname,
    slug,
    cast(is_active as boolean) as is_active,
    _ingest_date,
    _source_file
from {{ ref('espn_teams') }}
where team_id is not null
qualify row_number() over (partition by league, team_id order by _ingest_date desc, _source_file desc) = 1
