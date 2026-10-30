{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguehustlestatsplayer` payloads for one game date (request keys hustle-<date>) parsed to rows; values stay text until silver. NBA only. #}

with files as (

    select *
    from ({{ landing_files('stats', 'leaguehustlestatsplayer') }}) as landed
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
    {{ json_text('rows.row', '$[0]') }} as player_id,
    {{ json_text('rows.row', '$[1]') }} as player_name,
    {{ json_text('rows.row', '$[2]') }} as team_id,
    {{ json_text('rows.row', '$[3]') }} as team_abbreviation,
    {{ json_text('rows.row', '$[4]') }} as age,
    {{ json_text('rows.row', '$[5]') }} as g,
    {{ json_text('rows.row', '$[6]') }} as min,
    {{ json_text('rows.row', '$[7]') }} as contested_shots,
    {{ json_text('rows.row', '$[8]') }} as contested_shots_2pt,
    {{ json_text('rows.row', '$[9]') }} as contested_shots_3pt,
    {{ json_text('rows.row', '$[10]') }} as deflections,
    {{ json_text('rows.row', '$[11]') }} as charges_drawn,
    {{ json_text('rows.row', '$[12]') }} as screen_assists,
    {{ json_text('rows.row', '$[13]') }} as screen_ast_pts,
    {{ json_text('rows.row', '$[14]') }} as off_loose_balls_recovered,
    {{ json_text('rows.row', '$[15]') }} as def_loose_balls_recovered,
    {{ json_text('rows.row', '$[16]') }} as loose_balls_recovered,
    {{ json_text('rows.row', '$[17]') }} as pct_loose_balls_recovered_off,
    {{ json_text('rows.row', '$[18]') }} as pct_loose_balls_recovered_def,
    {{ json_text('rows.row', '$[19]') }} as off_boxouts,
    {{ json_text('rows.row', '$[20]') }} as def_boxouts,
    {{ json_text('rows.row', '$[21]') }} as box_out_player_team_rebs,
    {{ json_text('rows.row', '$[22]') }} as box_out_player_rebs,
    {{ json_text('rows.row', '$[23]') }} as box_outs,
    {{ json_text('rows.row', '$[24]') }} as pct_box_outs_off,
    {{ json_text('rows.row', '$[25]') }} as pct_box_outs_def,
    {{ json_text('rows.row', '$[26]') }} as pct_box_outs_team_reb,
    {{ json_text('rows.row', '$[27]') }} as pct_box_outs_reb
from rows
