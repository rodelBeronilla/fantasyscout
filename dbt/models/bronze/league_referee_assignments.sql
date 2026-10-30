{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The leagues' referee assignments as parsed at ingest (official.nba.com): one row per game per
   landed page, with the crew chief, referee, umpire and alternate and their uniform numbers.
   Values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('league', 'referee_assignments') }}) as landed
    {{ bronze_incremental_filter() }}

),

games as (

    select
        files.*,
        {{ json_rows('files.payload', '$.rows') }} as game
    from files

)

select
    games._source_file,
    games.league,
    games.season,
    games._ingest_date,
    games.request_key,
    {{ json_text('games.payload', '$.page_date') }} as page_date,
    {{ json_text('games.game', '$.game') }} as game,
    {{ json_text('games.game', '$.away_team') }} as away_team,
    {{ json_text('games.game', '$.home_team') }} as home_team,
    {{ json_text('games.game', '$.crew_chief') }} as crew_chief,
    {{ json_text('games.game', '$.crew_chief_number') }} as crew_chief_number,
    {{ json_text('games.game', '$.referee') }} as referee,
    {{ json_text('games.game', '$.referee_number') }} as referee_number,
    {{ json_text('games.game', '$.umpire') }} as umpire,
    {{ json_text('games.game', '$.umpire_number') }} as umpire_number,
    {{ json_text('games.game', '$.alternate') }} as alternate,
    {{ json_text('games.game', '$.alternate_number') }} as alternate_number
from games
