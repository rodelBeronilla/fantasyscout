{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `playergamelogs` payloads of the Usage measure set (request keys usage-...) parsed to rows; values stay text until silver. #}

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
    where files.request_key like 'usage-%'

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
    {{ json_text('rows.row', '$[12]') }} as usg_pct,
    {{ json_text('rows.row', '$[13]') }} as pct_fgm,
    {{ json_text('rows.row', '$[14]') }} as pct_fga,
    {{ json_text('rows.row', '$[15]') }} as pct_fg3m,
    {{ json_text('rows.row', '$[16]') }} as pct_fg3a,
    {{ json_text('rows.row', '$[17]') }} as pct_ftm,
    {{ json_text('rows.row', '$[18]') }} as pct_fta,
    {{ json_text('rows.row', '$[19]') }} as pct_oreb,
    {{ json_text('rows.row', '$[20]') }} as pct_dreb,
    {{ json_text('rows.row', '$[21]') }} as pct_reb,
    {{ json_text('rows.row', '$[22]') }} as pct_ast,
    {{ json_text('rows.row', '$[23]') }} as pct_tov,
    {{ json_text('rows.row', '$[24]') }} as pct_stl,
    {{ json_text('rows.row', '$[25]') }} as pct_blk,
    {{ json_text('rows.row', '$[26]') }} as pct_blka,
    {{ json_text('rows.row', '$[27]') }} as pct_pf,
    {{ json_text('rows.row', '$[28]') }} as pct_pfd,
    {{ json_text('rows.row', '$[29]') }} as pct_pts,
    {{ json_text('rows.row', '$[30]') }} as gp_rank,
    {{ json_text('rows.row', '$[31]') }} as w_rank,
    {{ json_text('rows.row', '$[32]') }} as l_rank,
    {{ json_text('rows.row', '$[33]') }} as w_pct_rank,
    {{ json_text('rows.row', '$[34]') }} as min_rank,
    {{ json_text('rows.row', '$[35]') }} as usg_pct_rank,
    {{ json_text('rows.row', '$[36]') }} as pct_fgm_rank,
    {{ json_text('rows.row', '$[37]') }} as pct_fga_rank,
    {{ json_text('rows.row', '$[38]') }} as pct_fg3m_rank,
    {{ json_text('rows.row', '$[39]') }} as pct_fg3a_rank,
    {{ json_text('rows.row', '$[40]') }} as pct_ftm_rank,
    {{ json_text('rows.row', '$[41]') }} as pct_fta_rank,
    {{ json_text('rows.row', '$[42]') }} as pct_oreb_rank,
    {{ json_text('rows.row', '$[43]') }} as pct_dreb_rank,
    {{ json_text('rows.row', '$[44]') }} as pct_reb_rank,
    {{ json_text('rows.row', '$[45]') }} as pct_ast_rank,
    {{ json_text('rows.row', '$[46]') }} as pct_tov_rank,
    {{ json_text('rows.row', '$[47]') }} as pct_stl_rank,
    {{ json_text('rows.row', '$[48]') }} as pct_blk_rank,
    {{ json_text('rows.row', '$[49]') }} as pct_blka_rank,
    {{ json_text('rows.row', '$[50]') }} as pct_pf_rank,
    {{ json_text('rows.row', '$[51]') }} as pct_pfd_rank,
    {{ json_text('rows.row', '$[52]') }} as pct_pts_rank,
    {{ json_text('rows.row', '$[53]') }} as available_flag,
    {{ json_text('rows.row', '$[54]') }} as min_sec,
    {{ json_text('rows.row', '$[55]') }} as team_count
from rows
