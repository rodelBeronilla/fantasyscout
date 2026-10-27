{# One row per player per game from the v3 advanced box score. Latest landing wins. #}

select
    league,
    season,
    game_id,
    person_id as player_id,
    league || ':' || game_id || ':' || person_id as player_game_key,
    team_id,
    side,
    {{ minutes_to_decimal('minutes') }} as minutes,
    try_cast(estimated_offensive_rating as double) as estimated_offensive_rating,
    try_cast(offensive_rating as double) as offensive_rating,
    try_cast(estimated_defensive_rating as double) as estimated_defensive_rating,
    try_cast(defensive_rating as double) as defensive_rating,
    try_cast(estimated_net_rating as double) as estimated_net_rating,
    try_cast(net_rating as double) as net_rating,
    try_cast(assist_percentage as double) as assist_percentage,
    try_cast(assist_to_turnover as double) as assist_to_turnover,
    try_cast(assist_ratio as double) as assist_ratio,
    try_cast(offensive_rebound_percentage as double) as offensive_rebound_percentage,
    try_cast(defensive_rebound_percentage as double) as defensive_rebound_percentage,
    try_cast(rebound_percentage as double) as rebound_percentage,
    try_cast(turnover_ratio as double) as turnover_ratio,
    try_cast(effective_field_goal_percentage as double) as effective_field_goal_percentage,
    try_cast(true_shooting_percentage as double) as true_shooting_percentage,
    try_cast(usage_percentage as double) as usage_percentage,
    try_cast(estimated_usage_percentage as double) as estimated_usage_percentage,
    try_cast(estimated_pace as double) as estimated_pace,
    try_cast(pace as double) as pace,
    try_cast(pace_per40 as double) as pace_per40,
    try_cast(possessions as double) as possessions,
    try_cast(pie as double) as pie,
    _ingest_date,
    _source_file
from {{ ref('stats_boxscoreadvancedv3') }}
where game_id is not null and person_id is not null
qualify row_number() over (partition by league, game_id, person_id order by _ingest_date desc, _source_file desc) = 1
