{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguedashptstats` payloads, passing tracking for one game date (request keys passing-<date>), parsed to rows; values stay text until silver. NBA only. #}

with files as (

    select *
    from ({{ landing_files('stats', 'leaguedashptstats') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'passing-%'

)

select
    rows._source_file,
    rows.league,
    rows.season,
    rows._ingest_date,
    rows.request_key,
    {{ sha256('rows.payload') }} as _payload_hash,
    {{ json_text('rows.row', '$[0]') }} as player_id,
    {{ json_text('rows.row', '$[1]') }} as player_name,
    {{ json_text('rows.row', '$[2]') }} as team_id,
    {{ json_text('rows.row', '$[3]') }} as team_abbreviation,
    {{ json_text('rows.row', '$[4]') }} as gp,
    {{ json_text('rows.row', '$[5]') }} as w,
    {{ json_text('rows.row', '$[6]') }} as l,
    {{ json_text('rows.row', '$[7]') }} as min,
    {{ json_text('rows.row', '$[8]') }} as passes_made,
    {{ json_text('rows.row', '$[9]') }} as passes_received,
    {{ json_text('rows.row', '$[10]') }} as ast,
    {{ json_text('rows.row', '$[11]') }} as ft_ast,
    {{ json_text('rows.row', '$[12]') }} as secondary_ast,
    {{ json_text('rows.row', '$[13]') }} as potential_ast,
    {{ json_text('rows.row', '$[14]') }} as ast_pts_created,
    {{ json_text('rows.row', '$[15]') }} as ast_adj,
    {{ json_text('rows.row', '$[16]') }} as ast_to_pass_pct,
    {{ json_text('rows.row', '$[17]') }} as ast_to_pass_pct_adj
from rows
