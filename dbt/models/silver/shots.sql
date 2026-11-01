{{
    config(
        materialized='incremental',
        incremental_strategy='merge',
        unique_key='shot_key',
        on_schema_change='append_new_columns',
        partition_by=(['league', 'season'] if target.type == 'databricks' else none),
        zorder=(['game_id'] if target.type == 'databricks' else none),
        pre_hook="{{ replace_changed_games([ref('stats_shotchartdetail')]) }}",
    )
}}

{#
  One row per field goal attempt with court coordinates. Latest landing wins per shot.

  Incremental by game (dbt/macros/incremental.sql): a landing carries one game's shots, or a
  team's whole season on a backfill; every game it carries is recomputed from all its landings
  and its rows replaced.
#}

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
    and {{ only_changed_games([ref('stats_shotchartdetail')]) }}
{{ latest_landing(['league', 'game_id', 'game_event_id']) }}
