{{ config(tags=['feed_reports']) }}

{#
  The outlets' feed items, one row per item: an item is its link, or its id when the feed gives
  no link, so the same story in an outlet's league feed and its team feed is one item, credited to
  the feed that carried it first. The newest landing gives the headline and summary, since outlets
  edit them. The earlier landings say when the item was first seen.

  published_date is the Eastern day of the outlet's publish time, but never later than the day we
  first saw the item: a feed that gives no date, or a date in the future, is dated by when it was
  read. A point-in-time build keeps the items published before its date.
#}

with seen as (

    select
        *,
        coalesce({{ clean_text('link') }}, {{ clean_text('item_guid') }}) as item_ref,
        {{ utc_timestamp('fetched_at') }} as fetched_ts
    from {{ ref('rss_items') }}
    where {{ clean_text('title') }} is not null
        and coalesce({{ clean_text('link') }}, {{ clean_text('item_guid') }}) is not null

),

first_seen as (

    select league, item_ref, feed_id, fetched_ts as first_seen_at
    from seen
    qualify row_number() over (partition by league, item_ref order by fetched_ts, feed_id) = 1

),

newest as (

    select *
    from seen
    qualify row_number() over (
        partition by league, item_ref order by _ingest_date desc, _source_file desc
    ) = 1

),

dated as (

    select
        n.league,
        n.season,
        f.feed_id,
        n.outlet,
        n.feed_team,
        n.feed_keep,
        n.item_ref,
        n.item_guid,
        trim(n.title) as title,
        {{ clean_text('n.link') }} as link,
        case when n.feed_keep = 'headline+summary' then {{ clean_text('n.summary') }} end as summary,
        {{ utc_timestamp('n.published_at') }} as published_at,
        f.first_seen_at
    from newest as n
    join first_seen as f on f.league = n.league and f.item_ref = n.item_ref

)

select
    league || ':' || substr({{ sha256('item_ref') }}, 1, 16) as rss_item_key,
    substr({{ sha256('item_ref') }}, 1, 16) as item_id,
    league,
    season,
    feed_id,
    outlet,
    feed_team,
    feed_keep,
    item_guid,
    title,
    link,
    summary,
    published_at,
    first_seen_at,
    {{ utc_to_eastern_date('least(coalesce(published_at, first_seen_at), first_seen_at)') }} as published_date
from dated
where {{ known_before(utc_to_eastern_date('least(coalesce(published_at, first_seen_at), first_seen_at)')) }}
