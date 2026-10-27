{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `shotchartdetail` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'shotchartdetail') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files

)

select
    rows._source_file,
    rows.league,
    rows.season,
    rows._ingest_date,
    rows.request_key,
    {{ sha256('rows.payload') }} as _payload_hash,
    {{ json_text('rows.row', '$[0]') }} as grid_type,
    {{ json_text('rows.row', '$[1]') }} as game_id,
    {{ json_text('rows.row', '$[2]') }} as game_event_id,
    {{ json_text('rows.row', '$[3]') }} as player_id,
    {{ json_text('rows.row', '$[4]') }} as player_name,
    {{ json_text('rows.row', '$[5]') }} as team_id,
    {{ json_text('rows.row', '$[6]') }} as team_name,
    {{ json_text('rows.row', '$[7]') }} as period,
    {{ json_text('rows.row', '$[8]') }} as minutes_remaining,
    {{ json_text('rows.row', '$[9]') }} as seconds_remaining,
    {{ json_text('rows.row', '$[10]') }} as event_type,
    {{ json_text('rows.row', '$[11]') }} as action_type,
    {{ json_text('rows.row', '$[12]') }} as shot_type,
    {{ json_text('rows.row', '$[13]') }} as shot_zone_basic,
    {{ json_text('rows.row', '$[14]') }} as shot_zone_area,
    {{ json_text('rows.row', '$[15]') }} as shot_zone_range,
    {{ json_text('rows.row', '$[16]') }} as shot_distance,
    {{ json_text('rows.row', '$[17]') }} as loc_x,
    {{ json_text('rows.row', '$[18]') }} as loc_y,
    {{ json_text('rows.row', '$[19]') }} as shot_attempted_flag,
    {{ json_text('rows.row', '$[20]') }} as shot_made_flag,
    {{ json_text('rows.row', '$[21]') }} as game_date,
    {{ json_text('rows.row', '$[22]') }} as htm,
    {{ json_text('rows.row', '$[23]') }} as vtm
from rows
