{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguestandingsv3` payloads parsed to rows (the columns the platform uses, by
   position in the result set); values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('stats', 'leaguestandingsv3') }}) as landed
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
    {{ sha256('cells.payload') }} as _payload_hash,
    {{ stats_cell('cells.cell', 'cells.headers', 'TeamID') }} as team_id,
    {{ stats_cell('cells.cell', 'cells.headers', 'TeamCity') }} as team_city,
    {{ stats_cell('cells.cell', 'cells.headers', 'TeamName') }} as team_name,
    {{ stats_cell('cells.cell', 'cells.headers', 'Conference') }} as conference,
    {{ stats_cell('cells.cell', 'cells.headers', 'PlayoffRank') }} as playoff_rank,
    {{ stats_cell('cells.cell', 'cells.headers', 'ClinchIndicator') }} as clinch_indicator,
    {{ stats_cell('cells.cell', 'cells.headers', 'WINS') }} as wins,
    {{ stats_cell('cells.cell', 'cells.headers', 'LOSSES') }} as losses,
    {{ stats_cell('cells.cell', 'cells.headers', 'WinPCT') }} as win_pct,
    {{ stats_cell('cells.cell', 'cells.headers', 'L10') }} as last_10,
    {{ stats_cell('cells.cell', 'cells.headers', 'strCurrentStreak') }} as current_streak,
    {{ stats_cell('cells.cell', 'cells.headers', 'ConferenceGamesBack') }} as conference_games_back,
    {{ stats_cell('cells.cell', 'cells.headers', 'ClinchedConferenceTitle') }} as clinched_conference,
    {{ stats_cell('cells.cell', 'cells.headers', 'ClinchedPlayoffBirth') }} as clinched_playoffs,
    {{ stats_cell('cells.cell', 'cells.headers', 'ClinchedPlayIn') }} as clinched_play_in,
    {{ stats_cell('cells.cell', 'cells.headers', 'EliminatedConference') }} as eliminated
from cells
