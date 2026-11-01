{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `commonteamroster` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *, {{ sha256('landed.payload') }} as _payload_hash
    from ({{ landing_files('stats', 'commonteamroster') }}) as landed
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
    {{ stats_cell('cells.cell', 'cells.headers', 'TeamID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'SEASON') }} as season_src,
    {{ stats_cell('cells.cell', 'cells.headers', 'LeagueID') }} as league_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER') }} as player,
    {{ stats_cell('cells.cell', 'cells.headers', 'NICKNAME') }} as nickname,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_SLUG') }} as player_slug,
    {{ stats_cell('cells.cell', 'cells.headers', 'NUM') }} as num,
    {{ stats_cell('cells.cell', 'cells.headers', 'POSITION') }} as position,
    {{ stats_cell('cells.cell', 'cells.headers', 'HEIGHT') }} as height,
    {{ stats_cell('cells.cell', 'cells.headers', 'WEIGHT') }} as weight,
    {{ stats_cell('cells.cell', 'cells.headers', 'BIRTH_DATE') }} as birth_date,
    {{ stats_cell('cells.cell', 'cells.headers', 'AGE') }} as age,
    {{ stats_cell('cells.cell', 'cells.headers', 'EXP') }} as exp,
    {{ stats_cell('cells.cell', 'cells.headers', 'SCHOOL') }} as school,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_ID') }} as player_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'HOW_ACQUIRED') }} as how_acquired,
    {{ stats_cell('cells.cell', 'cells.headers', 'SUPPLEMENTAL_STATUS') }} as supplemental_status
from cells
