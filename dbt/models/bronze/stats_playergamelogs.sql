{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `playergamelogs` payloads of the Advanced measure set (request keys advanced-...)
   parsed to rows; values stay text until silver. Usage and Misc have their own models. #}

with files as (

    select *
    from ({{ landing_files('stats', 'playergamelogs') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ stats_headers('files.payload') }} as headers,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'advanced-%'

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
    {{ sha256('cells.payload') }} as _payload_hash,
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
    {{ stats_cell('cells.cell', 'cells.headers', 'E_OFF_RATING') }} as e_off_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'OFF_RATING') }} as off_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_OFF_RATING') }} as sp_work_off_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_DEF_RATING') }} as e_def_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'DEF_RATING') }} as def_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_DEF_RATING') }} as sp_work_def_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_NET_RATING') }} as e_net_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'NET_RATING') }} as net_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_NET_RATING') }} as sp_work_net_rating,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_PCT') }} as ast_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_TO') }} as ast_to,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_RATIO') }} as ast_ratio,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_PCT') }} as oreb_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_PCT') }} as dreb_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_PCT') }} as reb_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'TM_TOV_PCT') }} as tm_tov_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_TOV_PCT') }} as e_tov_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'EFG_PCT') }} as efg_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'TS_PCT') }} as ts_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'USG_PCT') }} as usg_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_USG_PCT') }} as e_usg_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_PACE') }} as e_pace,
    {{ stats_cell('cells.cell', 'cells.headers', 'PACE') }} as pace,
    {{ stats_cell('cells.cell', 'cells.headers', 'PACE_PER40') }} as pace_per40,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_PACE') }} as sp_work_pace,
    {{ stats_cell('cells.cell', 'cells.headers', 'PIE') }} as pie,
    {{ stats_cell('cells.cell', 'cells.headers', 'POSS') }} as poss,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGM') }} as fgm,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGA') }} as fga,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGM_PG') }} as fgm_pg,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGA_PG') }} as fga_pg,
    {{ stats_cell('cells.cell', 'cells.headers', 'FG_PCT') }} as fg_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'GP_RANK') }} as gp_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'W_RANK') }} as w_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'L_RANK') }} as l_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'W_PCT_RANK') }} as w_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN_RANK') }} as min_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_OFF_RATING_RANK') }} as e_off_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'OFF_RATING_RANK') }} as off_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_OFF_RATING_RANK') }} as sp_work_off_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_DEF_RATING_RANK') }} as e_def_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'DEF_RATING_RANK') }} as def_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_DEF_RATING_RANK') }} as sp_work_def_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_NET_RATING_RANK') }} as e_net_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'NET_RATING_RANK') }} as net_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_NET_RATING_RANK') }} as sp_work_net_rating_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_PCT_RANK') }} as ast_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_TO_RANK') }} as ast_to_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST_RATIO_RANK') }} as ast_ratio_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_PCT_RANK') }} as oreb_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_PCT_RANK') }} as dreb_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_PCT_RANK') }} as reb_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'TM_TOV_PCT_RANK') }} as tm_tov_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_TOV_PCT_RANK') }} as e_tov_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'EFG_PCT_RANK') }} as efg_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'TS_PCT_RANK') }} as ts_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'USG_PCT_RANK') }} as usg_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_USG_PCT_RANK') }} as e_usg_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'E_PACE_RANK') }} as e_pace_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PACE_RANK') }} as pace_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'sp_work_PACE_RANK') }} as sp_work_pace_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'PIE_RANK') }} as pie_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGM_RANK') }} as fgm_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGA_RANK') }} as fga_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGM_PG_RANK') }} as fgm_pg_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGA_PG_RANK') }} as fga_pg_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'FG_PCT_RANK') }} as fg_pct_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVAILABLE_FLAG') }} as available_flag,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN_SEC') }} as min_sec,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_COUNT') }} as team_count
from cells
