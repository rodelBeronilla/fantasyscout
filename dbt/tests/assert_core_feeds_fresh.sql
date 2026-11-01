{{ config(severity='error', tags=['quality', 'freshness']) }}

-- In season, a core feed (ops.feed_freshness.is_core: the schedule, the game log, box scores,
-- play-by-play, shot charts, rosters, ESPN scoreboards) stale by more than two days past its
-- allowance blocks the publish: the board would otherwise go live on last week's games or
-- rosters while looking current. warn_stale_feeds flags the first stale day of every feed.
select league, feed, source_model, last_landed, age_days, max_age_days, status
from {{ ref('feed_freshness') }}
where is_core
    and in_season
    and (status = 'never' or age_days > max_age_days + 2)
