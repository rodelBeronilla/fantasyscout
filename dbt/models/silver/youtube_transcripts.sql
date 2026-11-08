{#
  The channels' video transcripts in chunks, one row per video and chunk, from the newest landing
  of each video's captions. A chunk is half a minute of the video's timed lines, joined in order
  by the ingest (ingest/youtube.py, chunk_lines), and is what the claims extractor reads as one
  item, so a quote stays a few words of a short span, with its start in the video. Private: never
  published or shown; gold.fct_player_youtube_item takes from it only which players each chunk
  names, and the extractor reads the words from the landed file itself, on the home runner.

  A chunk is dated by its video (silver.youtube_videos): the day the channel published it, never
  later than the feed first carried it, however much later the captions were fetched. A
  transcript of a video no feed landed has no row.
#}

with landed as (

    select
        *,
        try_cast(chunk_start as integer) as start_seconds,
        try_cast(chunk_end as double) as end_seconds
    from {{ ref('youtube_transcript_chunks') }}
    where {{ clean_text('chunk_text') }} is not null
        and {{ clean_text('video_id') }} is not null
        and try_cast(chunk_start as integer) is not null

),

newest as (

    select league, video_id, _source_file
    from (select distinct league, video_id, _ingest_date, _source_file from landed) as files
    qualify row_number() over (
        partition by league, video_id order by _ingest_date desc, _source_file desc
    ) = 1

)

select
    c.league || ':' || c.video_id || '-t' || cast(c.start_seconds as string) as youtube_chunk_key,
    c.video_id || '-t' || cast(c.start_seconds as string) as chunk_id,
    c.league,
    v.season,
    v.channel,
    v.channel_name,
    c.video_id,
    v.title,
    c.start_seconds,
    c.end_seconds,
    trim(c.chunk_text) as text,
    c.caption_language,
    c.caption_kind,
    v.link || '&t=' || cast(c.start_seconds as string) || 's' as link,
    v.published_at,
    v.first_seen_at,
    {{ utc_timestamp('c.fetched_at') }} as fetched_at,
    v.published_date
from landed as c
join newest as n
    on n.league = c.league and n.video_id = c.video_id and n._source_file = c._source_file
join {{ ref('youtube_videos') }} as v on v.league = c.league and v.video_id = c.video_id
where {{ known_before('v.published_date') }}
