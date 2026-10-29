{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The NBA's daily starting lineups: one row per player per team per game per landed file.
   Values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('league', 'daily_lineups') }}) as landed
    {{ bronze_incremental_filter() }}

),

games as (

    select
        files.*,
        {{ json_rows('files.payload', '$.games') }} as game
    from files

),

home as (

    select games.*, 'home' as side, {{ json_rows('games.game', '$.homeTeam.players') }} as player
    from games

),

away as (

    select games.*, 'away' as side, {{ json_rows('games.game', '$.awayTeam.players') }} as player
    from games

),

sides as (

    select * from home
    union all
    select * from away

)

select
    sides._source_file,
    sides.league,
    sides.season,
    sides._ingest_date,
    sides.request_key,
    {{ json_text('sides.game', '$.gameId') }} as game_id,
    {{ json_text('sides.game', '$.gameStatusText') }} as game_status_text,
    sides.side,
    {{ json_text('sides.player', '$.personId') }} as player_id,
    {{ json_text('sides.player', '$.teamId') }} as team_id,
    {{ json_text('sides.player', '$.playerName') }} as player_name,
    {{ json_text('sides.player', '$.position') }} as position,
    {{ json_text('sides.player', '$.lineupStatus') }} as lineup_status,
    {{ json_text('sides.player', '$.rosterStatus') }} as roster_status,
    {{ json_text('sides.player', '$.timestamp') }} as updated_at
from sides
