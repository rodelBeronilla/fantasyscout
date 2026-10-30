{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Sleeper's player directory as landed (NBA): one row per active player on a team per landing,
   with Sleeper's id and the fields that link the player to the league's ids. #}

with files as (

    select *
    from ({{ landing_files('sleeper', 'players') }}) as landed
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
    {{ json_text('players.player', '$.player_id') }} as sleeper_player_id,
    {{ json_text('players.player', '$.full_name') }} as full_name,
    {{ json_text('players.player', '$.search_full_name') }} as search_full_name,
    {{ json_text('players.player', '$.team') }} as team_abbreviation,
    {{ json_text('players.player', '$.birth_date') }} as birth_date
from players
