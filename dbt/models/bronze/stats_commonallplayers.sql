{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `commonallplayers` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *, {{ sha256('landed.payload') }} as _payload_hash
    from ({{ landing_files('stats', 'commonallplayers') }}) as landed
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
    {{ stats_cell('cells.cell', 'cells.headers', 'PERSON_ID') }} as person_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'DISPLAY_LAST_COMMA_FIRST') }} as display_last_comma_first,
    {{ stats_cell('cells.cell', 'cells.headers', 'DISPLAY_FIRST_LAST') }} as display_first_last,
    {{ stats_cell('cells.cell', 'cells.headers', 'ROSTERSTATUS') }} as rosterstatus,
    {{ stats_cell('cells.cell', 'cells.headers', 'FROM_YEAR') }} as from_year,
    {{ stats_cell('cells.cell', 'cells.headers', 'TO_YEAR') }} as to_year,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYERCODE') }} as playercode,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_SLUG') }} as player_slug,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_CITY') }} as team_city,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_NAME') }} as team_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ABBREVIATION') }} as team_abbreviation,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_CODE') }} as team_code,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_SLUG') }} as team_slug,
    {{ stats_cell('cells.cell', 'cells.headers', 'IS_NBA_ASSIGNED') }} as is_nba_assigned,
    {{ stats_cell('cells.cell', 'cells.headers', 'NBA_ASSIGNED_TEAM_ID') }} as nba_assigned_team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'GAMES_PLAYED_FLAG') }} as games_played_flag
from cells
