{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguedashptstats` payloads, possessions tracking for one game date (request keys possessions-<date>), parsed to rows; values stay text until silver. NBA only. #}

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
    where files.request_key like 'possessions-%'

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
    {{ stats_cell('cells.cell', 'cells.headers', 'POINTS') }} as points,
    {{ stats_cell('cells.cell', 'cells.headers', 'TOUCHES') }} as touches,
    {{ stats_cell('cells.cell', 'cells.headers', 'FRONT_CT_TOUCHES') }} as front_ct_touches,
    {{ stats_cell('cells.cell', 'cells.headers', 'TIME_OF_POSS') }} as time_of_poss,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_SEC_PER_TOUCH') }} as avg_sec_per_touch,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_DRIB_PER_TOUCH') }} as avg_drib_per_touch,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_PER_TOUCH') }} as pts_per_touch,
    {{ stats_cell('cells.cell', 'cells.headers', 'ELBOW_TOUCHES') }} as elbow_touches,
    {{ stats_cell('cells.cell', 'cells.headers', 'POST_TOUCHES') }} as post_touches,
    {{ stats_cell('cells.cell', 'cells.headers', 'PAINT_TOUCHES') }} as paint_touches,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_PER_ELBOW_TOUCH') }} as pts_per_elbow_touch,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_PER_POST_TOUCH') }} as pts_per_post_touch,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_PER_PAINT_TOUCH') }} as pts_per_paint_touch
from cells
