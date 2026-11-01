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
        {{ stats_headers('files.payload') }} as headers,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files

),

cells as (

    select
        rows.*,
        {{ stats_row_values('rows.row') }} as cell
    from rows

)

select
    cells._source_file,
    cells.league,
    cells.season,
    cells._ingest_date,
    cells.request_key,
    {{ sha256('cells.payload') }} as _payload_hash,
    {{ stats_cell('cells.cell', 'cells.headers', 'GRID_TYPE') }} as grid_type,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAME_ID') }} as game_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAME_EVENT_ID') }} as game_event_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_ID') }} as player_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_NAME') }} as player_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_NAME') }} as team_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'PERIOD') }} as period,
    {{ stats_cell('cells.cell', 'cells.headers', 'MINUTES_REMAINING') }} as minutes_remaining,
    {{ stats_cell('cells.cell', 'cells.headers', 'SECONDS_REMAINING') }} as seconds_remaining,
    {{ stats_cell('cells.cell', 'cells.headers', 'EVENT_TYPE') }} as event_type,
    {{ stats_cell('cells.cell', 'cells.headers', 'ACTION_TYPE') }} as action_type,
    {{ stats_cell('cells.cell', 'cells.headers', 'SHOT_TYPE') }} as shot_type,
    {{ stats_cell('cells.cell', 'cells.headers', 'SHOT_ZONE_BASIC') }} as shot_zone_basic,
    {{ stats_cell('cells.cell', 'cells.headers', 'SHOT_ZONE_AREA') }} as shot_zone_area,
    {{ stats_cell('cells.cell', 'cells.headers', 'SHOT_ZONE_RANGE') }} as shot_zone_range,
    {{ stats_cell('cells.cell', 'cells.headers', 'SHOT_DISTANCE') }} as shot_distance,
    {{ stats_cell('cells.cell', 'cells.headers', 'LOC_X') }} as loc_x,
    {{ stats_cell('cells.cell', 'cells.headers', 'LOC_Y') }} as loc_y,
    {{ stats_cell('cells.cell', 'cells.headers', 'SHOT_ATTEMPTED_FLAG') }} as shot_attempted_flag,
    {{ stats_cell('cells.cell', 'cells.headers', 'SHOT_MADE_FLAG') }} as shot_made_flag,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAME_DATE') }} as game_date,
    {{ stats_cell('cells.cell', 'cells.headers', 'HTM') }} as htm,
    {{ stats_cell('cells.cell', 'cells.headers', 'VTM') }} as vtm
from cells
