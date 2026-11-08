{#
  The local model's claims from the news, typed: one row per claim, from the newest landing of
  each source item. A re-extraction (--full-refresh) lands an item again, and its newest landing
  replaces every claim of the older one, so a claim the model no longer makes goes too. A point-in-
  time build keeps the claims whose source said them before its date (published_date), whenever
  they were extracted.
#}

with newest as (

    select *
    from {{ ref('ai_claims') }}
    where player_id is not null and kind is not null
    qualify dense_rank() over (
        partition by league, request_key order by _ingest_date desc, _source_file desc
    ) = 1

)

select
    league || ':' || source || ':' || source_id || ':' || player_id || ':' || kind as player_claim_key,
    league,
    season,
    source,
    source_id,
    player_id as stats_player_id,
    kind,
    cast(direction as integer) as direction,
    cast(confidence as double) as confidence,
    cast(model_confidence as double) as model_confidence,
    cast(confidence_cap as double) as confidence_cap,
    cap_reasons,
    quote,
    cast(quote_start as integer) as quote_start,
    source_text,
    {{ utc_timestamp('published_at') }} as published_at,
    cast(published_date as date) as published_date,
    {{ utc_timestamp('extracted_at') }} as extracted_at,
    model,
    prompt_version,
    _ingest_date,
    _source_file
from newest
where {{ known_before('cast(published_date as date)') }}
qualify row_number() over (
    partition by league, source, source_id, player_id, kind order by cast(confidence as double) desc
) = 1
