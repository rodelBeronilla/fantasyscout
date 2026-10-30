{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The officials ESPN lists on each game summary (gameInfo.officials): one row per official per
   landed summary. ESPN gives every official the position "Referee" and an order; values stay
   text until silver. A summary without the list (a game not yet played) gives no rows. #}

with files as (

    select *
    from ({{ landing_files('espn', 'summary') }}) as landed
    {{ bronze_incremental_filter() }}

),

officials as (

    select
        files.*,
        {{ json_rows('files.payload', '$.gameInfo.officials') }} as official
    from files

)

select
    officials._source_file,
    officials.league,
    officials.season,
    officials._ingest_date,
    officials.request_key,
    {{ json_text('officials.payload', '$.header.id') }} as event_id,
    {{ json_text('officials.official', '$.fullName') }} as full_name,
    {{ json_text('officials.official', '$.displayName') }} as display_name,
    {{ json_text('officials.official', '$.position.name') }} as position_name,
    {{ json_text('officials.official', '$.order') }} as listed_order
from officials
