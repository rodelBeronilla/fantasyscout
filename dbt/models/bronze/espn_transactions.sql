{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# ESPN's transactions feed: one row per team and day as ESPN writes it, per landed payload. #}

with files as (

    select *
    from ({{ landing_files('espn', 'transactions') }}) as landed
    {{ bronze_incremental_filter() }}

),

moves as (

    select
        files.*,
        {{ json_rows('files.payload', '$.transactions') }} as move
    from files

)

select
    moves._source_file,
    moves.league,
    moves.season,
    moves._ingest_date,
    moves.request_key,
    {{ json_text('moves.move', '$.date') }} as transaction_at,
    {{ json_text('moves.move', '$.description') }} as description,
    {{ json_text('moves.move', '$.team.id') }} as espn_team_id,
    {{ json_text('moves.move', '$.team.abbreviation') }} as team_abbreviation
from moves
