{{ config(severity='warn', tags=['quality', 'availability']) }}

-- At least 80% of the players on the latest injury report are linked to a league player id;
-- the rest are usually players on two-way or developmental deals missing from both rosters.
select league, count(*) as listed,
    count(stats_player_id) as linked,
    count(stats_player_id) * 1.0 / count(*) as linked_rate
from {{ ref('fct_availability') }}
where is_current
group by league
having count(*) >= 10 and count(stats_player_id) * 1.0 / count(*) < 0.8
