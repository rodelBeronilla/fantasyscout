{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The local model's claims from the news (ai/claims.py, #833): one row per claim per landed
   file. A file is one source item, an ESPN headline or injury note, with the text the model read
   and the claims that passed the extractor's checks; an item with no claim has no row. Values
   stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('ai', 'claims') }}) as landed
    {{ bronze_incremental_filter() }}

),

claims as (

    select
        files.*,
        {{ json_rows('files.payload', '$.claims') }} as claim
    from files

)

select
    claims._source_file,
    claims.league,
    claims.season,
    claims._ingest_date,
    claims.request_key,
    {{ json_text('claims.payload', '$.text') }} as source_text,
    {{ json_text('claims.payload', '$.model') }} as model,
    {{ json_text('claims.payload', '$.prompt') }} as prompt_version,
    {{ json_text('claims.payload', '$.extracted_at') }} as extracted_at,
    {{ json_text('claims.claim', '$.source') }} as source,
    {{ json_text('claims.claim', '$.source_id') }} as source_id,
    {{ json_text('claims.claim', '$.player_id') }} as player_id,
    {{ json_text('claims.claim', '$.kind') }} as kind,
    {{ json_text('claims.claim', '$.direction') }} as direction,
    {{ json_text('claims.claim', '$.model_confidence') }} as model_confidence,
    {{ json_text('claims.claim', '$.confidence_cap') }} as confidence_cap,
    {{ json_text('claims.claim', '$.confidence') }} as confidence,
    {{ json_text('claims.claim', '$.cap_reasons') }} as cap_reasons,
    {{ json_text('claims.claim', '$.quote') }} as quote,
    {{ json_text('claims.claim', '$.quote_start') }} as quote_start,
    {{ json_text('claims.claim', '$.published_at') }} as published_at,
    {{ json_text('claims.claim', '$.published_date') }} as published_date
from claims
