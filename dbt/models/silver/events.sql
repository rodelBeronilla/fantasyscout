{# One row per play-by-play action, typed. Latest landing wins. #}

select
    league,
    season,
    game_id,
    try_cast(action_number as integer) as action_number,
    league || ':' || game_id || ':' || action_number as event_key,
    try_cast(action_id as integer) as action_id,
    try_cast(period as integer) as period,
    clock,
    team_id,
    team_tricode,
    person_id as player_id,
    player_name,
    player_name_i as player_name_short,
    action_type,
    sub_type,
    description,
    location,
    cast(is_field_goal as boolean) as is_field_goal,
    shot_result,
    try_cast(shot_value as integer) as shot_value,
    try_cast(shot_distance as double) as shot_distance,
    try_cast(x_legacy as double) as x_legacy,
    try_cast(y_legacy as double) as y_legacy,
    try_cast(score_home as integer) as score_home,
    try_cast(score_away as integer) as score_away,
    try_cast(points_total as integer) as points_total,
    _ingest_date,
    _source_file
from {{ ref('stats_playbyplayv3') }}
where game_id is not null and action_number is not null
qualify row_number() over (partition by league, game_id, action_number order by _ingest_date desc, _source_file desc) = 1
