{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The leagues' official injury reports, as the ingest parsed them from the PDF: one row per
   player (or team not yet submitted) per landed report. Values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('league', 'injury_report') }}) as landed
    {{ bronze_incremental_filter() }}

),

listed as (

    select
        files.*,
        {{ json_rows('files.payload', '$.rows') }} as listing
    from files

)

select
    listed._source_file,
    listed.league,
    listed.season,
    listed._ingest_date,
    listed.request_key,
    {{ json_text('listed.payload', '$.report') }} as report,
    {{ json_text('listed.payload', '$.published_et') }} as published_et,
    {{ json_text('listed.payload', '$.pdf_sha256') }} as pdf_sha256,
    {{ json_text('listed.listing', '$.game_date') }} as game_date,
    {{ json_text('listed.listing', '$.game_time_et') }} as game_time_et,
    {{ json_text('listed.listing', '$.matchup') }} as matchup,
    {{ json_text('listed.listing', '$.team') }} as team,
    {{ json_text('listed.listing', '$.player_name') }} as player_name,
    {{ json_text('listed.listing', '$.player_name_listed') }} as player_name_listed,
    {{ json_text('listed.listing', '$.status') }} as status,
    {{ json_text('listed.listing', '$.reason') }} as reason,
    {{ json_text('listed.listing', '$.not_submitted') }} as not_submitted
from listed
