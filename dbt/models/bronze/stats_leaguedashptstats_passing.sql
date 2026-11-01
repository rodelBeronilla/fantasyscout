{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguedashptstats` payloads, passing tracking for one game date (request keys passing-<date>), parsed to rows; values stay text until silver. NBA only. #}

with files as (

    select *, {{ sha256('landed.payload') }} as _payload_hash
    from ({{ landing_files('stats', 'leaguedashptstats') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ stats_headers('files.payload') }} as headers,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'passing-%'

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
    cells._payload_hash,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_ID') }} as player_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_NAME') }} as player_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ABBREVIATION') }} as team_abbreviation,
    {{ stats_cell('cells.cell', 'cells.headers', 'GP') }} as gp,
    {{ stats_cell('cells.cell', 'cells.headers', 'W') }} as w,
    {{ stats_cell('cells.cell', 'cells.headers', 'L') }} as l,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN') }} as min,
    {{ stats_cell('cells.cell', 'cells.headers', 'PASSES_MADE') }} as passes_made,
    {{ stats_cell('cells.cell', 'cells.headers', 'PASSES_RECEIVED') }} as passes_received,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST') }} as ast,
    {{ stats_cell('cells.cell', 'cells.headers', 'FT_AST') }} as ft_ast,
    {{ stats_cell('cells.cell', 'cells.headers', 'SECONDARY_AST') }} as secondary_ast,
    {{ stats_cell('cells.cell', 'cells.headers', 'POTENTIAL_AST') }} as potential_ast,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_PTS_CREATED') }} as ast_pts_created,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_ADJ') }} as ast_adj,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_TO_PASS_PCT') }} as ast_to_pass_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_TO_PASS_PCT_ADJ') }} as ast_to_pass_pct_adj
from cells
