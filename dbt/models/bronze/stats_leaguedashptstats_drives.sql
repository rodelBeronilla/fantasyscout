{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguedashptstats` payloads, drives tracking for one game date (request keys drives-<date>), parsed to rows; values stay text until silver. NBA only. #}

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
    where files.request_key like 'drives-%'

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
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVES') }} as drives,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_FGM') }} as drive_fgm,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_FGA') }} as drive_fga,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_FG_PCT') }} as drive_fg_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_FTM') }} as drive_ftm,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_FTA') }} as drive_fta,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_FT_PCT') }} as drive_ft_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_PTS') }} as drive_pts,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_PTS_PCT') }} as drive_pts_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_PASSES') }} as drive_passes,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_PASSES_PCT') }} as drive_passes_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_AST') }} as drive_ast,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_AST_PCT') }} as drive_ast_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_TOV') }} as drive_tov,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_TOV_PCT') }} as drive_tov_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_PF') }} as drive_pf,
    {{ stats_cell('cells.cell', 'cells.headers', 'DRIVE_PF_PCT') }} as drive_pf_pct
from cells
