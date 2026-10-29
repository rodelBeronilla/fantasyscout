{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The closing betting line on each ESPN game summary (pickcenter, the first provider), as text. #}

with files as (

    select *
    from ({{ landing_files('espn', 'summary') }}) as landed
    {{ bronze_incremental_filter() }}

)

select
    files._source_file,
    files.league,
    files.season,
    files._ingest_date,
    files.request_key,
    {{ json_text('files.payload', '$.header.id') }} as event_id,
    {{ json_text('files.payload', '$.pickcenter[0].provider.name') }} as provider,
    {{ json_text('files.payload', '$.pickcenter[0].details') }} as details,
    {{ json_text('files.payload', '$.pickcenter[0].spread') }} as spread,
    {{ json_text('files.payload', '$.pickcenter[0].overUnder') }} as over_under,
    {{ json_text('files.payload', '$.pickcenter[0].homeTeamOdds.moneyLine') }} as home_moneyline,
    {{ json_text('files.payload', '$.pickcenter[0].awayTeamOdds.moneyLine') }} as away_moneyline
from files
