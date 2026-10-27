{# One row per player per league from the player directory. Latest landing wins. #}

select
    league,
    person_id as player_id,
    league || ':' || person_id as player_key,
    display_first_last as full_name,
    display_last_comma_first as last_comma_first,
    try_cast(rosterstatus as integer) = 1 as on_roster,
    try_cast(from_year as integer) as from_year,
    try_cast(to_year as integer) as to_year,
    player_slug,
    team_id,
    team_city,
    team_name,
    team_abbreviation,
    try_cast(games_played_flag = 'Y' as boolean) as has_played,
    _ingest_date,
    _source_file
from {{ ref('stats_commonallplayers') }}
where person_id is not null
qualify row_number() over (partition by league, person_id order by _ingest_date desc, _source_file desc) = 1
