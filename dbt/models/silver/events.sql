{{
    config(
        materialized='incremental',
        incremental_strategy='merge',
        unique_key='event_key',
        on_schema_change='append_new_columns',
        partition_by=(['league', 'season'] if target.type == 'databricks' else none),
        zorder=(['game_id'] if target.type == 'databricks' else none),
        pre_hook="{{ replace_changed_games([ref('stats_playbyplayv3')]) }}",
    )
}}

{#
  One row per play-by-play action, typed.

  A play-by-play landing is one whole game (its request key is the game id), so the newest landing
  of a game is the game: an action a corrected feed no longer carries is not kept from an older
  landing. Incremental by game (dbt/macros/incremental.sql): a run reads only the landings of the
  games whose play-by-play landed on or after the newest landing in the table, and replaces those
  games' rows; the games nothing landed for are not read.
#}

with landed as (

    -- every landing of the games this run recomputes (every game on a full build)
    select *
    from {{ ref('stats_playbyplayv3') }}
    where game_id is not null and action_number is not null
        and {{ only_changed_games([ref('stats_playbyplayv3')]) }}

),

newest as (

    {{ latest_snapshot('landed') }}

)

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
from newest
{{ latest_landing(['league', 'game_id', 'action_number']) }}
