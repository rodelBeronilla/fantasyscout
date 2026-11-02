{{ config(severity='warn', tags=['quality', 'availability']) }}

-- The players on the latest injury report linked to a league player id reach the good bound of
-- vars.quality_thresholds.listing_links, the one the data-quality notebook grades against; the
-- rest are usually players on two-way or developmental deals missing from both rosters.
select league, count(*) as listed,
    count(stats_player_id) as linked,
    count(stats_player_id) * 1.0 / count(*) as linked_rate
from {{ ref('fct_availability') }}
where is_current
group by league
having count(*) >= 10 and count(stats_player_id) * 1.0 / count(*) < {{ var('quality_thresholds')['listing_links'][0] }}
