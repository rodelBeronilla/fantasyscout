{{ config(severity='warn', tags=['quality']) }}

-- Lines inside plausible bounds for professional basketball: totals between 100 and 300 points,
-- spreads under 40, both sides implied to score, and the two implied scores adding up to the total.
select league, event_id, home_spread, over_under, home_implied_points, away_implied_points
from {{ ref('game_lines') }}
where over_under not between 100 and 300
    or abs(home_spread) >= 40
    or home_implied_points <= 0 or away_implied_points <= 0
    or abs(home_implied_points + away_implied_points - over_under) > 0.000001
