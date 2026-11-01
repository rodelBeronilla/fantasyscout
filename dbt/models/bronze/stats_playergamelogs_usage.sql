{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `playergamelogs` payloads of the Usage measure set (request keys usage-...) parsed to rows; values stay text until silver. #}

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
    where files.request_key like 'usage-%'

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
    {{ stats_cell('cells.cell', 'cells.headers', 'USG_PCT') }} as usg_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FGM') }} as pct_fgm,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FGA') }} as pct_fga,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FG3M') }} as pct_fg3m,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FG3A') }} as pct_fg3a,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FTM') }} as pct_ftm,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FTA') }} as pct_fta,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_OREB') }} as pct_oreb,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_DREB') }} as pct_dreb,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_REB') }} as pct_reb,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_AST') }} as pct_ast,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_TOV') }} as pct_tov,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_STL') }} as pct_stl,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BLK') }} as pct_blk,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BLKA') }} as pct_blka,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_PF') }} as pct_pf,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_PFD') }} as pct_pfd,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_PTS') }} as pct_pts,
    {{ stats_cell('cells.cell', 'cells.headers', 'GP_RANK') }} as gp_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'W_RANK') }} as w_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'L_RANK') }} as l_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'W_PCT_RANK') }} as w_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN_RANK') }} as min_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'USG_PCT_RANK') }} as usg_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FGM_RANK') }} as pct_fgm_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FGA_RANK') }} as pct_fga_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FG3M_RANK') }} as pct_fg3m_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FG3A_RANK') }} as pct_fg3a_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FTM_RANK') }} as pct_ftm_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_FTA_RANK') }} as pct_fta_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_OREB_RANK') }} as pct_oreb_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_DREB_RANK') }} as pct_dreb_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_REB_RANK') }} as pct_reb_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_AST_RANK') }} as pct_ast_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_TOV_RANK') }} as pct_tov_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_STL_RANK') }} as pct_stl_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BLK_RANK') }} as pct_blk_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BLKA_RANK') }} as pct_blka_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_PF_RANK') }} as pct_pf_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_PFD_RANK') }} as pct_pfd_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_PTS_RANK') }} as pct_pts_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVAILABLE_FLAG') }} as available_flag,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN_SEC') }} as min_sec,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_COUNT') }} as team_count
from cells
