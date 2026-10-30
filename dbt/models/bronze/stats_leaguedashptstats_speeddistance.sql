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
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'speeddistance-%'

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
    {{ json_text('rows.row', '$[8]') }} as dist_feet,
    {{ json_text('rows.row', '$[9]') }} as dist_miles,
    {{ json_text('rows.row', '$[10]') }} as dist_miles_off,
    {{ json_text('rows.row', '$[11]') }} as dist_miles_def,
    {{ json_text('rows.row', '$[12]') }} as avg_speed,
    {{ json_text('rows.row', '$[13]') }} as avg_speed_off,
    {{ json_text('rows.row', '$[14]') }} as avg_speed_def
from rows
