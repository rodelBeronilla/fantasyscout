{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguegamelog` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *, {{ sha256('landed.payload') }} as _payload_hash
    from ({{ landing_files('stats', 'leaguegamelog') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ stats_headers('files.payload') }} as headers,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files

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
    {{ stats_cell('cells.cell', 'cells.headers', 'SEASON_ID') }} as season_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ABBREVIATION') }} as team_abbreviation,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_NAME') }} as team_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAME_ID') }} as game_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAME_DATE') }} as game_date,
    {{ stats_cell('cells.cell', 'cells.headers', 'MATCHUP') }} as matchup,
    {{ stats_cell('cells.cell', 'cells.headers', 'WL') }} as wl,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN') }} as min,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGM') }} as fgm,
    {{ stats_cell('cells.cell', 'cells.headers', 'FGA') }} as fga,
    {{ stats_cell('cells.cell', 'cells.headers', 'FG_PCT') }} as fg_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'FG3M') }} as fg3m,
    {{ stats_cell('cells.cell', 'cells.headers', 'FG3A') }} as fg3a,
    {{ stats_cell('cells.cell', 'cells.headers', 'FG3_PCT') }} as fg3_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'FTM') }} as ftm,
    {{ stats_cell('cells.cell', 'cells.headers', 'FTA') }} as fta,
    {{ stats_cell('cells.cell', 'cells.headers', 'FT_PCT') }} as ft_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB') }} as oreb,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB') }} as dreb,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB') }} as reb,
    {{ stats_cell('cells.cell', 'cells.headers', 'AST') }} as ast,
    {{ stats_cell('cells.cell', 'cells.headers', 'STL') }} as stl,
    {{ stats_cell('cells.cell', 'cells.headers', 'BLK') }} as blk,
    {{ stats_cell('cells.cell', 'cells.headers', 'TOV') }} as tov,
    {{ stats_cell('cells.cell', 'cells.headers', 'PF') }} as pf,
    {{ stats_cell('cells.cell', 'cells.headers', 'PTS') }} as pts,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLUS_MINUS') }} as plus_minus,
    {{ stats_cell('cells.cell', 'cells.headers', 'VIDEO_AVAILABLE') }} as video_available
from cells
