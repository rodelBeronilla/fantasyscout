{{ config(severity='warn', tags=['quality']) }}

-- Source feeds that should be landing while the league is playing but have not landed within
-- their expected age (ops.feed_freshness), or have never landed at all in season. A stopped feed
-- keeps its last snapshot in silver and gold, where it would otherwise look current.
select league, feed, source_model, last_landed, age_days, max_age_days, status
from {{ ref('feed_freshness') }}
where status = 'stale' or (status = 'never' and in_season)
