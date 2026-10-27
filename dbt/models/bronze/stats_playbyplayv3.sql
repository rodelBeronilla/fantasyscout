{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `playbyplayv3` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'playbyplayv3') }}) as landed
    {{ bronze_incremental_filter() }}

),

actions as (

    select
        files.*,
        {{ json_rows('files.payload', '$.game.actions') }} as action
    from files

)

select
    actions._source_file,
    actions.league,
    actions.season,
    actions._ingest_date,
    actions.request_key,
    {{ sha256('actions.payload') }} as _payload_hash,
    {{ json_text('actions.payload', '$.game.gameId') }} as game_id,
    {{ json_text('actions.action', '$.actionNumber') }} as action_number,
    {{ json_text('actions.action', '$.clock') }} as clock,
    {{ json_text('actions.action', '$.period') }} as period,
    {{ json_text('actions.action', '$.teamId') }} as team_id,
    {{ json_text('actions.action', '$.teamTricode') }} as team_tricode,
    {{ json_text('actions.action', '$.personId') }} as person_id,
    {{ json_text('actions.action', '$.playerName') }} as player_name,
    {{ json_text('actions.action', '$.playerNameI') }} as player_name_i,
    {{ json_text('actions.action', '$.xLegacy') }} as x_legacy,
    {{ json_text('actions.action', '$.yLegacy') }} as y_legacy,
    {{ json_text('actions.action', '$.shotDistance') }} as shot_distance,
    {{ json_text('actions.action', '$.shotResult') }} as shot_result,
    {{ json_text('actions.action', '$.isFieldGoal') }} as is_field_goal,
    {{ json_text('actions.action', '$.scoreHome') }} as score_home,
    {{ json_text('actions.action', '$.scoreAway') }} as score_away,
    {{ json_text('actions.action', '$.pointsTotal') }} as points_total,
    {{ json_text('actions.action', '$.location') }} as location,
    {{ json_text('actions.action', '$.description') }} as description,
    {{ json_text('actions.action', '$.actionType') }} as action_type,
    {{ json_text('actions.action', '$.subType') }} as sub_type,
    {{ json_text('actions.action', '$.videoAvailable') }} as video_available,
    {{ json_text('actions.action', '$.shotValue') }} as shot_value,
    {{ json_text('actions.action', '$.actionId') }} as action_id
from actions
