{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `playergamelogs` payloads of the Misc measure set (request keys misc-...) parsed to rows; values stay text until silver. #}

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
    where files.request_key like 'misc-%'

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
    {{ json_text('rows.row', '$[12]') }} as pts_off_tov,
    {{ json_text('rows.row', '$[13]') }} as pts_2nd_chance,
    {{ json_text('rows.row', '$[14]') }} as pts_fb,
    {{ json_text('rows.row', '$[15]') }} as pts_paint,
    {{ json_text('rows.row', '$[16]') }} as opp_pts_off_tov,
    {{ json_text('rows.row', '$[17]') }} as opp_pts_2nd_chance,
    {{ json_text('rows.row', '$[18]') }} as opp_pts_fb,
    {{ json_text('rows.row', '$[19]') }} as opp_pts_paint,
    {{ json_text('rows.row', '$[20]') }} as blk,
    {{ json_text('rows.row', '$[21]') }} as blka,
    {{ json_text('rows.row', '$[22]') }} as pf,
    {{ json_text('rows.row', '$[23]') }} as pfd,
    {{ json_text('rows.row', '$[24]') }} as nba_fantasy_pts,
    {{ json_text('rows.row', '$[25]') }} as gp_rank,
    {{ json_text('rows.row', '$[26]') }} as w_rank,
    {{ json_text('rows.row', '$[27]') }} as l_rank,
    {{ json_text('rows.row', '$[28]') }} as w_pct_rank,
    {{ json_text('rows.row', '$[29]') }} as min_rank,
    {{ json_text('rows.row', '$[30]') }} as pts_off_tov_rank,
    {{ json_text('rows.row', '$[31]') }} as pts_2nd_chance_rank,
    {{ json_text('rows.row', '$[32]') }} as pts_fb_rank,
    {{ json_text('rows.row', '$[33]') }} as pts_paint_rank,
    {{ json_text('rows.row', '$[34]') }} as opp_pts_off_tov_rank,
    {{ json_text('rows.row', '$[35]') }} as opp_pts_2nd_chance_rank,
    {{ json_text('rows.row', '$[36]') }} as opp_pts_fb_rank,
    {{ json_text('rows.row', '$[37]') }} as opp_pts_paint_rank,
    {{ json_text('rows.row', '$[38]') }} as blk_rank,
    {{ json_text('rows.row', '$[39]') }} as blka_rank,
    {{ json_text('rows.row', '$[40]') }} as pf_rank,
    {{ json_text('rows.row', '$[41]') }} as pfd_rank,
    {{ json_text('rows.row', '$[42]') }} as nba_fantasy_pts_rank,
    {{ json_text('rows.row', '$[43]') }} as available_flag,
    {{ json_text('rows.row', '$[44]') }} as min_sec,
    {{ json_text('rows.row', '$[45]') }} as team_count
from rows
