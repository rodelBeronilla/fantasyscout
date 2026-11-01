{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguehustlestatsplayer` payloads for one game date (request keys hustle-<date>) parsed to rows; values stay text until silver. NBA only. #}

with files as (

    select *, {{ sha256('landed.payload') }} as _payload_hash
    from ({{ landing_files('stats', 'leaguehustlestatsplayer') }}) as landed
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
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_ID') }} as player_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_NAME') }} as player_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ABBREVIATION') }} as team_abbreviation,
    {{ stats_cell('cells.cell', 'cells.headers', 'AGE') }} as age,
    {{ stats_cell('cells.cell', 'cells.headers', 'G') }} as g,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN') }} as min,
    {{ stats_cell('cells.cell', 'cells.headers', 'CONTESTED_SHOTS') }} as contested_shots,
    {{ stats_cell('cells.cell', 'cells.headers', 'CONTESTED_SHOTS_2PT') }} as contested_shots_2pt,
    {{ stats_cell('cells.cell', 'cells.headers', 'CONTESTED_SHOTS_3PT') }} as contested_shots_3pt,
    {{ stats_cell('cells.cell', 'cells.headers', 'DEFLECTIONS') }} as deflections,
    {{ stats_cell('cells.cell', 'cells.headers', 'CHARGES_DRAWN') }} as charges_drawn,
    {{ stats_cell('cells.cell', 'cells.headers', 'SCREEN_ASSISTS') }} as screen_assists,
    {{ stats_cell('cells.cell', 'cells.headers', 'SCREEN_AST_PTS') }} as screen_ast_pts,
    {{ stats_cell('cells.cell', 'cells.headers', 'OFF_LOOSE_BALLS_RECOVERED') }} as off_loose_balls_recovered,
    {{ stats_cell('cells.cell', 'cells.headers', 'DEF_LOOSE_BALLS_RECOVERED') }} as def_loose_balls_recovered,
    {{ stats_cell('cells.cell', 'cells.headers', 'LOOSE_BALLS_RECOVERED') }} as loose_balls_recovered,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_LOOSE_BALLS_RECOVERED_OFF') }} as pct_loose_balls_recovered_off,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_LOOSE_BALLS_RECOVERED_DEF') }} as pct_loose_balls_recovered_def,
    {{ stats_cell('cells.cell', 'cells.headers', 'OFF_BOXOUTS') }} as off_boxouts,
    {{ stats_cell('cells.cell', 'cells.headers', 'DEF_BOXOUTS') }} as def_boxouts,
    {{ stats_cell('cells.cell', 'cells.headers', 'BOX_OUT_PLAYER_TEAM_REBS') }} as box_out_player_team_rebs,
    {{ stats_cell('cells.cell', 'cells.headers', 'BOX_OUT_PLAYER_REBS') }} as box_out_player_rebs,
    {{ stats_cell('cells.cell', 'cells.headers', 'BOX_OUTS') }} as box_outs,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BOX_OUTS_OFF') }} as pct_box_outs_off,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BOX_OUTS_DEF') }} as pct_box_outs_def,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BOX_OUTS_TEAM_REB') }} as pct_box_outs_team_reb,
    {{ stats_cell('cells.cell', 'cells.headers', 'PCT_BOX_OUTS_REB') }} as pct_box_outs_reb
from cells
