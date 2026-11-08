{{ config(severity='error', tags=['claims']) }}

-- Every claim comes from a known source: an ESPN headline, an ESPN injury note, an outlet's feed
-- by its id (rss:<feed_id>, ingest/rss_feeds.toml) or a YouTube channel by its id (youtube:<channel>,
-- ingest/youtube_channels.toml). The walk-forward harness scores each source's
-- track record, so a source it cannot name would be scored as a source of its own.
select source, count(*) as claims
from {{ ref('player_claims') }}
where not (
    source in ('espn_news', 'espn_injury_note')
    or {{ matches('source', '^rss:[a-z0-9]+(-[a-z0-9]+)*$') }}
    or {{ matches('source', '^youtube:[a-z0-9]+(-[a-z0-9]+)*$') }}
)
group by source
