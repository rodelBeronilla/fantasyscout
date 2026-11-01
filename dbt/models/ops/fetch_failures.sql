{{ config(materialized='table') }}

{#
  Every request an ingest run could not land, one row each, from the run logs the ingestors write
  under landing/_ops/ingest_log: the failures (an error of ours or the host's) and the payloads
  missing at the source (HTTP 404). ingest_log keeps the counts; this names the endpoint and key,
  so Data Health can show a request that fails every day and a replay can target exactly these
  keys (fs-ingest land ... --from-run-log, or --only endpoint:key).
#}

with files as (

    {{ raw_json_files('landing/_ops/ingest_log/*/*.json') }}

),

runs as (

    select
        {{ json_text('payload', '$.run_id') }} as run_id,
        {{ json_text('payload', '$.source') }} as source,
        {{ json_text('payload', '$.league') }} as league,
        {{ json_text('payload', '$.season') }} as season,
        cast({{ json_text('payload', '$.started_at') }} as timestamp) as started_at,
        payload,
        _source_file
    from files

),

failed as (

    select
        run_id, source, league, season, started_at, _source_file,
        'failed' as kind,
        {{ json_rows('runs.payload', '$.failures') }} as item
    from runs

),

missing as (

    select
        run_id, source, league, season, started_at, _source_file,
        'missing' as kind,
        {{ json_rows('runs.payload', '$.missing') }} as item
    from runs

),

items as (

    select * from failed
    union all
    select * from missing

)

select
    run_id,
    source,
    league,
    season,
    started_at,
    kind,
    {{ json_text('item', '$.endpoint') }} as endpoint,
    {{ json_text('item', '$.key') }} as request_key,
    {{ json_text('item', '$.reason') }} as reason,
    _source_file
from items
