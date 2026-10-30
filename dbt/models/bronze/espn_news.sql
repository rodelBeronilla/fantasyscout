{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# ESPN's news feed: one row per article and athlete it is tagged with, per landed payload,
   with the headline, its date and the link to the story on ESPN. The story itself is never
   landed; an article tagged with no athlete has no row. #}

with files as (

    select *
    from ({{ landing_files('espn', 'news') }}) as landed
    {{ bronze_incremental_filter() }}

),

articles as (

    select
        files.*,
        {{ json_rows('files.payload', '$.articles') }} as article
    from files

),

tagged as (

    select
        articles.*,
        {{ json_rows('articles.article', '$.athletes') }} as athlete
    from articles

)

select
    tagged._source_file,
    tagged.league,
    tagged.season,
    tagged._ingest_date,
    tagged.request_key,
    {{ json_text('tagged.article', '$.id') }} as article_id,
    {{ json_text('tagged.article', '$.type') }} as article_type,
    {{ json_text('tagged.article', '$.headline') }} as headline,
    {{ json_text('tagged.article', '$.published') }} as published_at,
    {{ json_text('tagged.article', '$.url') }} as url,
    {{ json_text('tagged.athlete', '$.id') }} as espn_player_id,
    {{ json_text('tagged.athlete', '$.name') }} as athlete_name
from tagged
