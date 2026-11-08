{#
  The YouTube channels' videos, one row per video: the newest landing's title and description
  (channels edit them), the first time a feed carried it, and the day it was published.

  published_date is the Eastern day of the channel's publish time, but never later than the day
  the feed first carried it: a video dated in the future, or not dated, is dated by when it was
  read. A point-in-time build keeps the videos published before its date.
#}

with seen as (

    select
        *,
        {{ utc_timestamp('fetched_at') }} as fetched_ts
    from {{ ref('youtube_video_items') }}
    where {{ clean_text('video_id') }} is not null
        and {{ clean_text('title') }} is not null

),

first_seen as (

    select league, video_id, min(fetched_ts) as first_seen_at
    from seen
    group by league, video_id

),

newest as (

    select *
    from seen
    qualify row_number() over (
        partition by league, video_id order by _ingest_date desc, _source_file desc
    ) = 1

),

dated as (

    select
        n.league,
        n.season,
        n.channel,
        n.channel_name,
        n.channel_id,
        n.video_id,
        trim(n.title) as title,
        {{ clean_text('n.description') }} as description,
        {{ clean_text('n.link') }} as link,
        {{ utc_timestamp('n.published_at') }} as published_at,
        f.first_seen_at
    from newest as n
    join first_seen as f on f.league = n.league and f.video_id = n.video_id

)

select
    league || ':' || video_id as youtube_video_key,
    league,
    season,
    channel,
    channel_name,
    channel_id,
    video_id,
    title,
    description,
    link,
    published_at,
    first_seen_at,
    {{ utc_to_eastern_date('least(coalesce(published_at, first_seen_at), first_seen_at)') }} as published_date
from dated
where {{ known_before(utc_to_eastern_date('least(coalesce(published_at, first_seen_at), first_seen_at)')) }}
