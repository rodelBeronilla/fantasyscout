{# One row per player per game from ESPN, stats unpacked by position in stat_keys. Latest landing wins. #}

select
    league,
    season,
    event_id,
    athlete_id,
    league || ':' || event_id || ':' || athlete_id as player_game_key,
    cast(substr(event_date, 1, 10) as date) as event_date,
    team_id,
    athlete_name,
    jersey,
    position,
    cast(starter as boolean) as starter,
    cast(did_not_play as boolean) as did_not_play,
    reason,
    {{ minutes_to_decimal(json_text('stats', '$[0]')) }} as minutes,
    try_cast({{ json_text('stats', '$[1]') }} as integer) as points,
    {{ made_of(json_text('stats', '$[2]')) }} as field_goals_made,
    {{ attempted_of(json_text('stats', '$[2]')) }} as field_goals_attempted,
    {{ made_of(json_text('stats', '$[3]')) }} as three_pointers_made,
    {{ attempted_of(json_text('stats', '$[3]')) }} as three_pointers_attempted,
    {{ made_of(json_text('stats', '$[4]')) }} as free_throws_made,
    {{ attempted_of(json_text('stats', '$[4]')) }} as free_throws_attempted,
    try_cast({{ json_text('stats', '$[5]') }} as integer) as rebounds_total,
    try_cast({{ json_text('stats', '$[6]') }} as integer) as assists,
    try_cast({{ json_text('stats', '$[7]') }} as integer) as turnovers,
    try_cast({{ json_text('stats', '$[8]') }} as integer) as steals,
    try_cast({{ json_text('stats', '$[9]') }} as integer) as blocks,
    try_cast({{ json_text('stats', '$[10]') }} as integer) as rebounds_offensive,
    try_cast({{ json_text('stats', '$[11]') }} as integer) as rebounds_defensive,
    try_cast({{ json_text('stats', '$[12]') }} as integer) as fouls_personal,
    try_cast({{ json_text('stats', '$[13]') }} as integer) as plus_minus,
    stat_keys,
    _ingest_date,
    _source_file
from {{ ref('espn_summary_players') }}
where event_id is not null and athlete_id is not null
    and {{ json_text('stat_keys', '$[0]') }} = 'minutes'
    and {{ json_text('stat_keys', '$[1]') }} = 'points'
qualify row_number() over (partition by league, event_id, athlete_id order by _ingest_date desc, _source_file desc) = 1
