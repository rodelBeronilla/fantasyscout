{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Sleeper's trending players as landed (NBA): one row per player and direction (add or drop)
   per landing, with how many Sleeper leagues made the move over the lookback window. #}

with files as (

    select *
    from ({{ landing_files('sleeper', 'trending') }}) as landed
    {{ bronze_incremental_filter() }}

),

adds as (

    select files.*, 'add' as direction, {{ json_rows('files.payload', '$.add') }} as move
    from files

),

drops as (

    select files.*, 'drop' as direction, {{ json_rows('files.payload', '$.drop') }} as move
    from files

),

moves as (

    select * from adds
    union all
    select * from drops

)

select
    moves._source_file,
    moves.league,
    moves.season,
    moves._ingest_date,
    moves.request_key,
    {{ json_text('moves.payload', '$.lookback_hours') }} as lookback_hours,
    moves.direction,
    {{ json_text('moves.move', '$.player_id') }} as sleeper_player_id,
    {{ json_text('moves.move', '$.count') }} as move_count
from moves
