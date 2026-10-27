{# One row per team-season. #}

select
    {{ sk(['league', 'season', 'team_id']) }} as team_sk,
    league,
    season,
    team_id,
    abbreviation,
    coalesce(name, team_name) as name,
    city,
    conference,
    team_name as full_name,
    note
from {{ ref('teams') }}
