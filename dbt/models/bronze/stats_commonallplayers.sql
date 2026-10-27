{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `commonallplayers` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'commonallplayers') }}) as landed
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
    {{ json_text('rows.row', '$[0]') }} as person_id,
    {{ json_text('rows.row', '$[1]') }} as display_last_comma_first,
    {{ json_text('rows.row', '$[2]') }} as display_first_last,
    {{ json_text('rows.row', '$[3]') }} as rosterstatus,
    {{ json_text('rows.row', '$[4]') }} as from_year,
    {{ json_text('rows.row', '$[5]') }} as to_year,
    {{ json_text('rows.row', '$[6]') }} as playercode,
    {{ json_text('rows.row', '$[7]') }} as player_slug,
    {{ json_text('rows.row', '$[8]') }} as team_id,
    {{ json_text('rows.row', '$[9]') }} as team_city,
    {{ json_text('rows.row', '$[10]') }} as team_name,
    {{ json_text('rows.row', '$[11]') }} as team_abbreviation,
    {{ json_text('rows.row', '$[12]') }} as team_code,
    {{ json_text('rows.row', '$[13]') }} as team_slug,
    {{ json_text('rows.row', '$[14]') }} as is_nba_assigned,
    {{ json_text('rows.row', '$[15]') }} as nba_assigned_team_id,
    {{ json_text('rows.row', '$[16]') }} as games_played_flag
from rows
