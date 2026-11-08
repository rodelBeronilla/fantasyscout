{#
  What the news claims about each player (#812, #833): one row per claim the local model read from
  an ESPN headline or injury note, about a league player the item names, with its kind, its
  direction, its confidence (the model's, capped by rule), the exact quote it rests on and the date
  the source said it.

  Nothing reads it yet: claims are not shown on the site and change no number. They are kept so
  the walk-forward harness (#769) can score each source's track record against what happened next,
  and a claim may tune a projection only once a rule built on that record beats the numbers alone
  out of sample (the epic's "tune only when proven" rule). A point-in-time build keeps the claims
  said before its date. A claim about a player dim_player does not have is dropped.
#}

select
    {{ sk(['c.league', 'c.source', 'c.source_id', 'c.stats_player_id', 'c.kind']) }} as player_claim_sk,
    c.league,
    c.season,
    c.stats_player_id,
    c.source,
    c.source_id,
    c.kind,
    c.direction,
    c.confidence,
    c.model_confidence,
    c.confidence_cap,
    c.cap_reasons,
    c.quote,
    c.quote_start,
    c.published_at,
    c.published_date,
    c.extracted_at,
    c.model,
    c.prompt_version
from {{ ref('player_claims') }} as c
where {{ known_before('c.published_date') }}
    and exists (
        select 1 from {{ ref('dim_player') }} as p
        where p.league = c.league and p.stats_player_id = c.stats_player_id
    )
