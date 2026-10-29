{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The betting line on each ESPN scoreboard event (the first provider listed), as text. Upcoming
   games carry it; ESPN drops it from a scoreboard once the game is final. #}

with files as (

    select *
    from ({{ landing_files('espn', 'scoreboard') }}) as landed
    {{ bronze_incremental_filter() }}

),

events as (

    select
        files.*,
        {{ json_rows('files.payload', '$.events') }} as event
    from files

)

select
    events._source_file,
    events.league,
    events.season,
    events._ingest_date,
    events.request_key,
    {{ json_text('events.event', '$.id') }} as event_id,
    {{ json_text('events.event', '$.competitions[0].odds[0].provider.name') }} as provider,
    {{ json_text('events.event', '$.competitions[0].odds[0].details') }} as details,
    {{ json_text('events.event', '$.competitions[0].odds[0].spread') }} as spread,
    {{ json_text('events.event', '$.competitions[0].odds[0].overUnder') }} as over_under,
    {{ json_text('events.event', '$.competitions[0].odds[0].moneyline.home.close.odds') }} as home_moneyline,
    {{ json_text('events.event', '$.competitions[0].odds[0].moneyline.away.close.odds') }} as away_moneyline
from events
