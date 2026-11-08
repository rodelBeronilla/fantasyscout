{{ config(tags=['feed_reports'], partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The outlets' RSS and Atom feeds (ingest/rss.py): one row per item per landed payload, a payload
   being one feed in one Eastern hour. The headline, link and publish time, and the feed's own
   summary only where the feed's terms allow it (ingest/rss_feeds.toml, ADR 0008 addendum of
   2026-11-08). The linked articles are never fetched. Values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('rss', 'items') }}) as landed
    {{ bronze_incremental_filter() }}

),

items as (

    select
        files.*,
        {{ json_rows('files.payload', '$.items') }} as item
    from files

)

select
    items._source_file,
    items.league,
    items.season,
    items._ingest_date,
    items.request_key,
    {{ json_text('items.payload', '$.feed.id') }} as feed_id,
    {{ json_text('items.payload', '$.feed.outlet') }} as outlet,
    {{ json_text('items.payload', '$.feed.team') }} as feed_team,
    {{ json_text('items.payload', '$.feed.keep') }} as feed_keep,
    {{ json_text('items.payload', '$.fetched_at') }} as fetched_at,
    {{ json_text('items.item', '$.id') }} as item_guid,
    {{ json_text('items.item', '$.title') }} as title,
    {{ json_text('items.item', '$.link') }} as link,
    {{ json_text('items.item', '$.published') }} as published_at,
    {{ json_text('items.item', '$.summary') }} as summary
from items
