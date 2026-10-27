{# One row per ESPN athlete per league from the team rosters, for names and birthdates. Latest landing wins. #}

select
    league,
    athlete_id,
    league || ':' || athlete_id as espn_player_key,
    full_name,
    first_name,
    last_name,
    team_id,
    position,
    jersey,
    {{ espn_birth_date('date_of_birth') }} as birth_date,
    _ingest_date,
    _source_file
from {{ ref('espn_roster') }}
where athlete_id is not null
qualify row_number() over (partition by league, athlete_id order by _ingest_date desc, _source_file desc) = 1
