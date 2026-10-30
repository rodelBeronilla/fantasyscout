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
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'drives-%'

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
    {{ json_text('rows.row', '$[8]') }} as drives,
    {{ json_text('rows.row', '$[9]') }} as drive_fgm,
    {{ json_text('rows.row', '$[10]') }} as drive_fga,
    {{ json_text('rows.row', '$[11]') }} as drive_fg_pct,
    {{ json_text('rows.row', '$[12]') }} as drive_ftm,
    {{ json_text('rows.row', '$[13]') }} as drive_fta,
    {{ json_text('rows.row', '$[14]') }} as drive_ft_pct,
    {{ json_text('rows.row', '$[15]') }} as drive_pts,
    {{ json_text('rows.row', '$[16]') }} as drive_pts_pct,
    {{ json_text('rows.row', '$[17]') }} as drive_passes,
    {{ json_text('rows.row', '$[18]') }} as drive_passes_pct,
    {{ json_text('rows.row', '$[19]') }} as drive_ast,
    {{ json_text('rows.row', '$[20]') }} as drive_ast_pct,
    {{ json_text('rows.row', '$[21]') }} as drive_tov,
    {{ json_text('rows.row', '$[22]') }} as drive_tov_pct,
    {{ json_text('rows.row', '$[23]') }} as drive_pf,
    {{ json_text('rows.row', '$[24]') }} as drive_pf_pct
from rows
