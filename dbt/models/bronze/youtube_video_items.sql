{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The YouTube channels' video feeds (ingest/youtube.py): one row per video per landed payload, a
   payload being one channel's feed on the day its videos changed. The title, the description (at
   most 2,000 characters) and the publish time; no view counts. Values stay text until silver.
   Read on the owner's decision in ADR 0008's addendum of 2026-11-08. #}

with files as (

    select *
    from ({{ landing_files('youtube', 'videos') }}) as landed
    {{ bronze_incremental_filter() }}

),

videos as (

    select
        files.*,
        {{ json_rows('files.payload', '$.videos') }} as video
    from files

)

select
    videos._source_file,
    videos.league,
    videos.season,
    videos._ingest_date,
    videos.request_key,
    {{ json_text('videos.payload', '$.channel.id') }} as channel,
    {{ json_text('videos.payload', '$.channel.name') }} as channel_name,
    {{ json_text('videos.payload', '$.channel.channel_id') }} as channel_id,
    {{ json_text('videos.payload', '$.fetched_at') }} as fetched_at,
    {{ json_text('videos.video', '$.id') }} as video_id,
    {{ json_text('videos.video', '$.title') }} as title,
    {{ json_text('videos.video', '$.description') }} as description,
    {{ json_text('videos.video', '$.link') }} as link,
    {{ json_text('videos.video', '$.published') }} as published_at
from videos
