{# One row per field goal attempt with court coordinates. Latest landing wins. #}

select
    league,
    season,
    game_id,
    try_cast(game_event_id as integer) as game_event_id,
    league || ':' || game_id || ':' || game_event_id as shot_key,
    player_id,
    player_name,
    team_id,
    team_name,
    try_cast(period as integer) as period,
    try_cast(minutes_remaining as integer) as minutes_remaining,
    try_cast(seconds_remaining as integer) as seconds_remaining,
    event_type,
    action_type,
    shot_type,
    shot_zone_basic,
    shot_zone_area,
    shot_zone_range,
    try_cast(shot_distance as integer) as shot_distance,
    try_cast(loc_x as integer) as loc_x,
    try_cast(loc_y as integer) as loc_y,
    try_cast(shot_attempted_flag as integer) = 1 as shot_attempted,
    try_cast(shot_made_flag as integer) = 1 as shot_made,
    {{ yyyymmdd_to_date('game_date') }} as game_date,
    htm as home_team_tricode,
    vtm as away_team_tricode,
    _ingest_date,
    _source_file
from {{ ref('stats_shotchartdetail') }}
where game_id is not null and game_event_id is not null
qualify row_number() over (partition by league, game_id, game_event_id order by _ingest_date desc, _source_file desc) = 1
