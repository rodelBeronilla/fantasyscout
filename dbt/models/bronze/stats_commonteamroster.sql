{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `commonteamroster` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'commonteamroster') }}) as landed
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
    {{ json_text('rows.row', '$[0]') }} as team_id,
    {{ json_text('rows.row', '$[1]') }} as season_src,
    {{ json_text('rows.row', '$[2]') }} as league_id,
    {{ json_text('rows.row', '$[3]') }} as player,
    {{ json_text('rows.row', '$[4]') }} as nickname,
    {{ json_text('rows.row', '$[5]') }} as player_slug,
    {{ json_text('rows.row', '$[6]') }} as num,
    {{ json_text('rows.row', '$[7]') }} as position,
    {{ json_text('rows.row', '$[8]') }} as height,
    {{ json_text('rows.row', '$[9]') }} as weight,
    {{ json_text('rows.row', '$[10]') }} as birth_date,
    {{ json_text('rows.row', '$[11]') }} as age,
    {{ json_text('rows.row', '$[12]') }} as exp,
    {{ json_text('rows.row', '$[13]') }} as school,
    {{ json_text('rows.row', '$[14]') }} as player_id,
    {{ json_text('rows.row', '$[15]') }} as how_acquired,
    {{ json_text('rows.row', '$[16]') }} as supplemental_status
from rows
