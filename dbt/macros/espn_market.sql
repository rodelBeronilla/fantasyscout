{#
  ESPN fantasy's market rows, as landed under one endpoint: fantasy_players (the daily market) or
  fantasy_adp (a past season's, landed once, #786). Values stay text until silver.
#}
{% macro espn_market_rows(endpoint) -%}
with files as (

    select *
    from ({{ landing_files('espn', endpoint) }}) as landed
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
{%- endmacro %}
