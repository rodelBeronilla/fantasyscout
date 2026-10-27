{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw espn `scoreboard` payloads parsed to rows; values stay text until silver.  #}

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
    {{ sha256('events.payload') }} as _payload_hash,
    {{ json_text('events.event', '$.id') }} as event_id,
    {{ json_text('events.event', '$.uid') }} as event_uid,
    {{ json_text('events.event', '$.date') }} as event_date,
    {{ json_text('events.event', '$.name') }} as name,
    {{ json_text('events.event', '$.shortName') }} as short_name,
    {{ json_text('events.event', '$.season.year') }} as season_year,
    {{ json_text('events.event', '$.season.type') }} as season_type,
    {{ json_text('events.event', '$.status.type.name') }} as status_name,
    {{ json_text('events.event', '$.status.type.state') }} as status_state,
    {{ json_text('events.event', '$.status.type.completed') }} as status_completed,
    {{ json_text('events.event', '$.status.period') }} as status_period,
    {{ json_text('events.event', '$.competitions[0].id') }} as competition_id,
    {{ json_text('events.event', '$.competitions[0].neutralSite') }} as neutral_site,
    {{ json_text('events.event', '$.competitions[0].venue.fullName') }} as venue_name,
    {{ json_text('events.event', '$.competitions[0].competitors') }} as competitors
from events
