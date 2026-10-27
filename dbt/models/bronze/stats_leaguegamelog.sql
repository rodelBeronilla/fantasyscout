{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguegamelog` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'leaguegamelog') }}) as landed
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
    {{ json_text('rows.row', '$[0]') }} as season_id,
    {{ json_text('rows.row', '$[1]') }} as team_id,
    {{ json_text('rows.row', '$[2]') }} as team_abbreviation,
    {{ json_text('rows.row', '$[3]') }} as team_name,
    {{ json_text('rows.row', '$[4]') }} as game_id,
    {{ json_text('rows.row', '$[5]') }} as game_date,
    {{ json_text('rows.row', '$[6]') }} as matchup,
    {{ json_text('rows.row', '$[7]') }} as wl,
    {{ json_text('rows.row', '$[8]') }} as min,
    {{ json_text('rows.row', '$[9]') }} as fgm,
    {{ json_text('rows.row', '$[10]') }} as fga,
    {{ json_text('rows.row', '$[11]') }} as fg_pct,
    {{ json_text('rows.row', '$[12]') }} as fg3m,
    {{ json_text('rows.row', '$[13]') }} as fg3a,
    {{ json_text('rows.row', '$[14]') }} as fg3_pct,
    {{ json_text('rows.row', '$[15]') }} as ftm,
    {{ json_text('rows.row', '$[16]') }} as fta,
    {{ json_text('rows.row', '$[17]') }} as ft_pct,
    {{ json_text('rows.row', '$[18]') }} as oreb,
    {{ json_text('rows.row', '$[19]') }} as dreb,
    {{ json_text('rows.row', '$[20]') }} as reb,
    {{ json_text('rows.row', '$[21]') }} as ast,
    {{ json_text('rows.row', '$[22]') }} as stl,
    {{ json_text('rows.row', '$[23]') }} as blk,
    {{ json_text('rows.row', '$[24]') }} as tov,
    {{ json_text('rows.row', '$[25]') }} as pf,
    {{ json_text('rows.row', '$[26]') }} as pts,
    {{ json_text('rows.row', '$[27]') }} as plus_minus,
    {{ json_text('rows.row', '$[28]') }} as video_available
from rows
