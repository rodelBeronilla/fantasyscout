{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `playergamelogs` payloads of the Misc measure set (request keys misc-...) parsed to rows; values stay text until silver. #}

with files as (

    select *, {{ sha256('landed.payload') }} as _payload_hash
    from ({{ landing_files('stats', 'playergamelogs') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ stats_headers('files.payload') }} as headers,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'misc-%'

),

cells as (

    select
        rows.*,
        {{ stats_row_values('rows.row') }} as cell
    from rows

)

select
    cells._source_file,
    cells.league,
    cells.season,
    cells._ingest_date,
    cells.request_key,
    cells._payload_hash,
    {{ stats_cell('cells.cell', 'cells.headers', 'SEASON_YEAR') }} as season_year,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_ID') }} as player_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_NAME') }} as player_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'NICKNAME') }} as nickname,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ABBREVIATION') }} as team_abbreviation,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_NAME') }} as team_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAME_ID') }} as game_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAME_DATE') }} as game_date,
    {{ stats_cell('cells.cell', 'cells.headers', 'MATCHUP') }} as matchup,
    {{ stats_cell('cells.cell', 'cells.headers', 'WL') }} as wl,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN') }} as min,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_OFF_TOV') }} as pts_off_tov,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_2ND_CHANCE') }} as pts_2nd_chance,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_FB') }} as pts_fb,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_PAINT') }} as pts_paint,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_OFF_TOV') }} as opp_pts_off_tov,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_2ND_CHANCE') }} as opp_pts_2nd_chance,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_FB') }} as opp_pts_fb,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_PAINT') }} as opp_pts_paint,
    {{ stats_cell('cells.cell', 'cells.headers', 'BLK') }} as blk,
    {{ stats_cell('cells.cell', 'cells.headers', 'BLKA') }} as blka,
    {{ stats_cell('cells.cell', 'cells.headers', 'PF') }} as pf,
    {{ stats_cell('cells.cell', 'cells.headers', 'PFD') }} as pfd,
    {{ stats_cell('cells.cell', 'cells.headers', 'NBA_FANTASY_PTS') }} as nba_fantasy_pts,
    {{ stats_cell('cells.cell', 'cells.headers', 'GP_RANK') }} as gp_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'W_RANK') }} as w_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'L_RANK') }} as l_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'W_PCT_RANK') }} as w_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN_RANK') }} as min_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_OFF_TOV_RANK') }} as pts_off_tov_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_2ND_CHANCE_RANK') }} as pts_2nd_chance_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_FB_RANK') }} as pts_fb_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS_PAINT_RANK') }} as pts_paint_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_OFF_TOV_RANK') }} as opp_pts_off_tov_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_2ND_CHANCE_RANK') }} as opp_pts_2nd_chance_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_FB_RANK') }} as opp_pts_fb_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'OPP_PTS_PAINT_RANK') }} as opp_pts_paint_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'BLK_RANK') }} as blk_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'BLKA_RANK') }} as blka_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PF_RANK') }} as pf_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PFD_RANK') }} as pfd_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'NBA_FANTASY_PTS_RANK') }} as nba_fantasy_pts_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVAILABLE_FLAG') }} as available_flag,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN_SEC') }} as min_sec,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_COUNT') }} as team_count
from cells
