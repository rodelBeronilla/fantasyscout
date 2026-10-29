{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The NBA's player movement feed, the last 180 days as landed: one row per move. #}

with files as (

    select *
    from ({{ landing_files('league', 'player_movement') }}) as landed
    {{ bronze_incremental_filter() }}

),

moves as (

    select
        files.*,
        {{ json_rows('files.payload', '$.NBA_Player_Movement.rows') }} as move
    from files

)

select
    moves._source_file,
    moves.league,
    moves.season,
    moves._ingest_date,
    moves.request_key,
    {{ json_text('moves.move', '$.TRANSACTION_DATE') }} as transaction_date,
    {{ json_text('moves.move', '$.Transaction_Type') }} as transaction_type,
    {{ json_text('moves.move', '$.TRANSACTION_DESCRIPTION') }} as description,
    {{ json_text('moves.move', '$.TEAM_ID') }} as team_id,
    {{ json_text('moves.move', '$.PLAYER_ID') }} as player_id
from moves
