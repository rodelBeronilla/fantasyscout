{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguedashptstats` payloads, speeddistance tracking for one game date (request keys speeddistance-<date>), parsed to rows; values stay text until silver. NBA only. #}

with files as (

    select *
    from ({{ landing_files('stats', 'leaguedashptstats') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ stats_headers('files.payload') }} as headers,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'speeddistance-%'

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
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_ID') }} as player_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_NAME') }} as player_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ABBREVIATION') }} as team_abbreviation,
    {{ stats_cell('cells.cell', 'cells.headers', 'GP') }} as gp,
    {{ stats_cell('cells.cell', 'cells.headers', 'W') }} as w,
    {{ stats_cell('cells.cell', 'cells.headers', 'L') }} as l,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN') }} as min,
    {{ stats_cell('cells.cell', 'cells.headers', 'DIST_FEET') }} as dist_feet,
    {{ stats_cell('cells.cell', 'cells.headers', 'DIST_MILES') }} as dist_miles,
    {{ stats_cell('cells.cell', 'cells.headers', 'DIST_MILES_OFF') }} as dist_miles_off,
    {{ stats_cell('cells.cell', 'cells.headers', 'DIST_MILES_DEF') }} as dist_miles_def,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_SPEED') }} as avg_speed,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_SPEED_OFF') }} as avg_speed_off,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_SPEED_DEF') }} as avg_speed_def
from cells
