{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguedashptstats` payloads, rebounding tracking for one game date (request keys rebounding-<date>), parsed to rows; values stay text until silver. NBA only. #}

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
    where files.request_key like 'rebounding-%'

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
    {{ json_text('rows.row', '$[8]') }} as oreb,
    {{ json_text('rows.row', '$[9]') }} as oreb_contest,
    {{ json_text('rows.row', '$[10]') }} as oreb_uncontest,
    {{ json_text('rows.row', '$[11]') }} as oreb_contest_pct,
    {{ json_text('rows.row', '$[12]') }} as oreb_chances,
    {{ json_text('rows.row', '$[13]') }} as oreb_chance_pct,
    {{ json_text('rows.row', '$[14]') }} as oreb_chance_defer,
    {{ json_text('rows.row', '$[15]') }} as oreb_chance_pct_adj,
    {{ json_text('rows.row', '$[16]') }} as avg_oreb_dist,
    {{ json_text('rows.row', '$[17]') }} as dreb,
    {{ json_text('rows.row', '$[18]') }} as dreb_contest,
    {{ json_text('rows.row', '$[19]') }} as dreb_uncontest,
    {{ json_text('rows.row', '$[20]') }} as dreb_contest_pct,
    {{ json_text('rows.row', '$[21]') }} as dreb_chances,
    {{ json_text('rows.row', '$[22]') }} as dreb_chance_pct,
    {{ json_text('rows.row', '$[23]') }} as dreb_chance_defer,
    {{ json_text('rows.row', '$[24]') }} as dreb_chance_pct_adj,
    {{ json_text('rows.row', '$[25]') }} as avg_dreb_dist,
    {{ json_text('rows.row', '$[26]') }} as reb,
    {{ json_text('rows.row', '$[27]') }} as reb_contest,
    {{ json_text('rows.row', '$[28]') }} as reb_uncontest,
    {{ json_text('rows.row', '$[29]') }} as reb_contest_pct,
    {{ json_text('rows.row', '$[30]') }} as reb_chances,
    {{ json_text('rows.row', '$[31]') }} as reb_chance_pct,
    {{ json_text('rows.row', '$[32]') }} as reb_chance_defer,
    {{ json_text('rows.row', '$[33]') }} as reb_chance_pct_adj,
    {{ json_text('rows.row', '$[34]') }} as avg_reb_dist
from rows
