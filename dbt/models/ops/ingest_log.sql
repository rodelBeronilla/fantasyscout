{{ config(materialized='table') }}

{# One row per ingest run, from the run logs the ingestors write under landing/_ops/ingest_log. #}

with files as (

    {{ raw_json_files('landing/_ops/ingest_log/*/*.json') }}

)

select
    {{ json_text('payload', '$.run_id') }} as run_id,
    {{ json_text('payload', '$.source') }} as source,
    {{ json_text('payload', '$.league') }} as league,
    {{ json_text('payload', '$.season') }} as season,
    cast({{ json_text('payload', '$.started_at') }} as timestamp) as started_at,
    cast({{ json_text('payload', '$.finished_at') }} as timestamp) as finished_at,
    cast({{ json_text('payload', '$.window.since') }} as date) as window_since,
    cast({{ json_text('payload', '$.window.until') }} as date) as window_until,
    cast({{ json_text('payload', '$.full_refresh') }} as boolean) as full_refresh,
    {{ json_text('payload', '$.backend') }} as backend,
    try_cast({{ json_text('payload', '$.games') }} as integer) as games,
    try_cast({{ json_text('payload', '$.landed') }} as integer) as landed,
    try_cast({{ json_text('payload', '$.unchanged') }} as integer) as unchanged,
    try_cast({{ json_text('payload', '$.skipped') }} as integer) as skipped,
    {{ json_array_len('payload', '$.failures') }} as failures,
    {{ json_array_len('payload', '$.missing') }} as missing_at_source,
    _source_file
from files
