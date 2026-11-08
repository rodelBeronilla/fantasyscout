{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The caption transcripts of the YouTube channels' new videos (ingest/youtube.py), fetched from
   the home runner only: one row per half-minute chunk per landed transcript, a transcript being
   one video. The ingest chunks the timed lines it lands (chunk_lines), so the lakehouse and the
   claims extractor read the same chunks. Private: never published, never shown. Values stay text
   until silver. #}

with files as (

    select *
    from ({{ landing_files('youtube', 'transcripts') }}) as landed
    {{ bronze_incremental_filter() }}

),

chunks as (

    select
        files.*,
        {{ json_rows('files.payload', '$.chunks') }} as chunk
    from files

)

select
    chunks._source_file,
    chunks.league,
    chunks.season,
    chunks._ingest_date,
    chunks.request_key,
    {{ json_text('chunks.payload', '$.channel.id') }} as channel,
    {{ json_text('chunks.payload', '$.channel.name') }} as channel_name,
    {{ json_text('chunks.payload', '$.video.id') }} as video_id,
    {{ json_text('chunks.payload', '$.video.title') }} as video_title,
    {{ json_text('chunks.payload', '$.video.published') }} as video_published_at,
    {{ json_text('chunks.payload', '$.captions.language') }} as caption_language,
    {{ json_text('chunks.payload', '$.captions.kind') }} as caption_kind,
    {{ json_text('chunks.payload', '$.fetched_at') }} as fetched_at,
    {{ json_text('chunks.chunk', '$.start') }} as chunk_start,
    {{ json_text('chunks.chunk', '$.end') }} as chunk_end,
    {{ json_text('chunks.chunk', '$.text') }} as chunk_text
from chunks
