{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# ESPN fantasy's market as landed: one row per player per landing, with how widely ESPN leagues
   roster and start the player, the average draft position and auction value, and ESPN's draft
   ranks. Values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('espn', 'fantasy_players') }}) as landed
    {{ bronze_incremental_filter() }}

),

players as (

    select
        files.*,
        {{ json_rows('files.payload', '$.players') }} as player
    from files

)

select
    players._source_file,
    players.league,
    players.season,
    players._ingest_date,
    players.request_key,
    {{ json_text('players.player', '$.id') }} as espn_player_id,
    {{ json_text('players.player', '$.fullName') }} as full_name,
    {{ json_text('players.player', '$.proTeamId') }} as espn_team_id,
    {{ json_text('players.player', '$.defaultPositionId') }} as position_id,
    {{ json_text('players.player', '$.ownership.percentOwned') }} as percent_owned,
    {{ json_text('players.player', '$.ownership.percentStarted') }} as percent_started,
    {{ json_text('players.player', '$.ownership.averageDraftPosition') }} as average_draft_position,
    {{ json_text('players.player', '$.ownership.auctionValueAverage') }} as auction_value_average,
    {{ json_text('players.player', '$.ownership.percentChange') }} as percent_owned_change,
    {{ json_text('players.player', '$.draftRanks.STANDARD') }} as espn_rank_standard,
    {{ json_text('players.player', '$.draftRanks.ROTO') }} as espn_rank_roto
from players
