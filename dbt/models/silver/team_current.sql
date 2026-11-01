{#
  Each team as it is named today: the latest season's row of silver.teams per league team id, with
  the keys the feeds are matched on (the official report writes "LosAngelesLakers", the props
  quotes a full name or a nickname). Six gold models used to carry their own copy of this lookup.
#}

select
    league,
    team_id,
    season as latest_season,
    abbreviation,
    team_name,
    name,
    lower(replace(team_name, ' ', '')) as team_key,
    {{ norm_name('team_name') }} as full_key,
    {{ norm_name('name') }} as nick_key
from {{ ref('teams') }}
qualify row_number() over (partition by league, team_id order by season desc) = 1
