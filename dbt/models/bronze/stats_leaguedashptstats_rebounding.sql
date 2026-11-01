{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguedashptstats` payloads, rebounding tracking for one game date (request keys rebounding-<date>), parsed to rows; values stay text until silver. NBA only. #}

with files as (

    select *
    from ({{ landing_files('stats', 'leaguedashptstats') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ stats_headers('files.payload') }} as headers,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files
    where files.request_key like 'rebounding-%'

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
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_ID') }} as player_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'PLAYER_NAME') }} as player_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TEAM_ABBREVIATION') }} as team_abbreviation,
    {{ stats_cell('cells.cell', 'cells.headers', 'GP') }} as gp,
    {{ stats_cell('cells.cell', 'cells.headers', 'W') }} as w,
    {{ stats_cell('cells.cell', 'cells.headers', 'L') }} as l,
    {{ stats_cell('cells.cell', 'cells.headers', 'MIN') }} as min,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB') }} as oreb,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_CONTEST') }} as oreb_contest,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_UNCONTEST') }} as oreb_uncontest,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_CONTEST_PCT') }} as oreb_contest_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_CHANCES') }} as oreb_chances,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_CHANCE_PCT') }} as oreb_chance_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_CHANCE_DEFER') }} as oreb_chance_defer,
    {{ stats_cell('cells.cell', 'cells.headers', 'OREB_CHANCE_PCT_ADJ') }} as oreb_chance_pct_adj,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_OREB_DIST') }} as avg_oreb_dist,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB') }} as dreb,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_CONTEST') }} as dreb_contest,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_UNCONTEST') }} as dreb_uncontest,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_CONTEST_PCT') }} as dreb_contest_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_CHANCES') }} as dreb_chances,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_CHANCE_PCT') }} as dreb_chance_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_CHANCE_DEFER') }} as dreb_chance_defer,
    {{ stats_cell('cells.cell', 'cells.headers', 'DREB_CHANCE_PCT_ADJ') }} as dreb_chance_pct_adj,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_DREB_DIST') }} as avg_dreb_dist,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB') }} as reb,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_CONTEST') }} as reb_contest,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_UNCONTEST') }} as reb_uncontest,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_CONTEST_PCT') }} as reb_contest_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_CHANCES') }} as reb_chances,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_CHANCE_PCT') }} as reb_chance_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_CHANCE_DEFER') }} as reb_chance_defer,
    {{ stats_cell('cells.cell', 'cells.headers', 'REB_CHANCE_PCT_ADJ') }} as reb_chance_pct_adj,
    {{ stats_cell('cells.cell', 'cells.headers', 'AVG_REB_DIST') }} as avg_reb_dist
from cells
