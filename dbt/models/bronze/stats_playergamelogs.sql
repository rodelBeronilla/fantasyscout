{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `playergamelogs` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'playergamelogs') }}) as landed
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
    {{ json_text('rows.row', '$[0]') }} as season_year,
    {{ json_text('rows.row', '$[1]') }} as player_id,
    {{ json_text('rows.row', '$[2]') }} as player_name,
    {{ json_text('rows.row', '$[3]') }} as nickname,
    {{ json_text('rows.row', '$[4]') }} as team_id,
    {{ json_text('rows.row', '$[5]') }} as team_abbreviation,
    {{ json_text('rows.row', '$[6]') }} as team_name,
    {{ json_text('rows.row', '$[7]') }} as game_id,
    {{ json_text('rows.row', '$[8]') }} as game_date,
    {{ json_text('rows.row', '$[9]') }} as matchup,
    {{ json_text('rows.row', '$[10]') }} as wl,
    {{ json_text('rows.row', '$[11]') }} as min,
    {{ json_text('rows.row', '$[12]') }} as e_off_rating,
    {{ json_text('rows.row', '$[13]') }} as off_rating,
    {{ json_text('rows.row', '$[14]') }} as sp_work_off_rating,
    {{ json_text('rows.row', '$[15]') }} as e_def_rating,
    {{ json_text('rows.row', '$[16]') }} as def_rating,
    {{ json_text('rows.row', '$[17]') }} as sp_work_def_rating,
    {{ json_text('rows.row', '$[18]') }} as e_net_rating,
    {{ json_text('rows.row', '$[19]') }} as net_rating,
    {{ json_text('rows.row', '$[20]') }} as sp_work_net_rating,
    {{ json_text('rows.row', '$[21]') }} as ast_pct,
    {{ json_text('rows.row', '$[22]') }} as ast_to,
    {{ json_text('rows.row', '$[23]') }} as ast_ratio,
    {{ json_text('rows.row', '$[24]') }} as oreb_pct,
    {{ json_text('rows.row', '$[25]') }} as dreb_pct,
    {{ json_text('rows.row', '$[26]') }} as reb_pct,
    {{ json_text('rows.row', '$[27]') }} as tm_tov_pct,
    {{ json_text('rows.row', '$[28]') }} as e_tov_pct,
    {{ json_text('rows.row', '$[29]') }} as efg_pct,
    {{ json_text('rows.row', '$[30]') }} as ts_pct,
    {{ json_text('rows.row', '$[31]') }} as usg_pct,
    {{ json_text('rows.row', '$[32]') }} as e_usg_pct,
    {{ json_text('rows.row', '$[33]') }} as e_pace,
    {{ json_text('rows.row', '$[34]') }} as pace,
    {{ json_text('rows.row', '$[35]') }} as pace_per40,
    {{ json_text('rows.row', '$[36]') }} as sp_work_pace,
    {{ json_text('rows.row', '$[37]') }} as pie,
    {{ json_text('rows.row', '$[38]') }} as poss,
    {{ json_text('rows.row', '$[39]') }} as fgm,
    {{ json_text('rows.row', '$[40]') }} as fga,
    {{ json_text('rows.row', '$[41]') }} as fgm_pg,
    {{ json_text('rows.row', '$[42]') }} as fga_pg,
    {{ json_text('rows.row', '$[43]') }} as fg_pct,
    {{ json_text('rows.row', '$[44]') }} as gp_rank,
    {{ json_text('rows.row', '$[45]') }} as w_rank,
    {{ json_text('rows.row', '$[46]') }} as l_rank,
    {{ json_text('rows.row', '$[47]') }} as w_pct_rank,
    {{ json_text('rows.row', '$[48]') }} as min_rank,
    {{ json_text('rows.row', '$[49]') }} as e_off_rating_rank,
    {{ json_text('rows.row', '$[50]') }} as off_rating_rank,
    {{ json_text('rows.row', '$[51]') }} as sp_work_off_rating_rank,
    {{ json_text('rows.row', '$[52]') }} as e_def_rating_rank,
    {{ json_text('rows.row', '$[53]') }} as def_rating_rank,
    {{ json_text('rows.row', '$[54]') }} as sp_work_def_rating_rank,
    {{ json_text('rows.row', '$[55]') }} as e_net_rating_rank,
    {{ json_text('rows.row', '$[56]') }} as net_rating_rank,
    {{ json_text('rows.row', '$[57]') }} as sp_work_net_rating_rank,
    {{ json_text('rows.row', '$[58]') }} as ast_pct_rank,
    {{ json_text('rows.row', '$[59]') }} as ast_to_rank,
    {{ json_text('rows.row', '$[60]') }} as ast_ratio_rank,
    {{ json_text('rows.row', '$[61]') }} as oreb_pct_rank,
    {{ json_text('rows.row', '$[62]') }} as dreb_pct_rank,
    {{ json_text('rows.row', '$[63]') }} as reb_pct_rank,
    {{ json_text('rows.row', '$[64]') }} as tm_tov_pct_rank,
    {{ json_text('rows.row', '$[65]') }} as e_tov_pct_rank,
    {{ json_text('rows.row', '$[66]') }} as efg_pct_rank,
    {{ json_text('rows.row', '$[67]') }} as ts_pct_rank,
    {{ json_text('rows.row', '$[68]') }} as usg_pct_rank,
    {{ json_text('rows.row', '$[69]') }} as e_usg_pct_rank,
    {{ json_text('rows.row', '$[70]') }} as e_pace_rank,
    {{ json_text('rows.row', '$[71]') }} as pace_rank,
    {{ json_text('rows.row', '$[72]') }} as sp_work_pace_rank,
    {{ json_text('rows.row', '$[73]') }} as pie_rank,
    {{ json_text('rows.row', '$[74]') }} as fgm_rank,
    {{ json_text('rows.row', '$[75]') }} as fga_rank,
    {{ json_text('rows.row', '$[76]') }} as fgm_pg_rank,
    {{ json_text('rows.row', '$[77]') }} as fga_pg_rank,
    {{ json_text('rows.row', '$[78]') }} as fg_pct_rank,
    {{ json_text('rows.row', '$[79]') }} as available_flag,
    {{ json_text('rows.row', '$[80]') }} as min_sec,
    {{ json_text('rows.row', '$[81]') }} as team_count
from rows
