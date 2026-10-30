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
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'possessions-%'

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
    {{ json_text('rows.row', '$[8]') }} as points,
    {{ json_text('rows.row', '$[9]') }} as touches,
    {{ json_text('rows.row', '$[10]') }} as front_ct_touches,
    {{ json_text('rows.row', '$[11]') }} as time_of_poss,
    {{ json_text('rows.row', '$[12]') }} as avg_sec_per_touch,
    {{ json_text('rows.row', '$[13]') }} as avg_drib_per_touch,
    {{ json_text('rows.row', '$[14]') }} as pts_per_touch,
    {{ json_text('rows.row', '$[15]') }} as elbow_touches,
    {{ json_text('rows.row', '$[16]') }} as post_touches,
    {{ json_text('rows.row', '$[17]') }} as paint_touches,
    {{ json_text('rows.row', '$[18]') }} as pts_per_elbow_touch,
    {{ json_text('rows.row', '$[19]') }} as pts_per_post_touch,
    {{ json_text('rows.row', '$[20]') }} as pts_per_paint_touch
from rows
