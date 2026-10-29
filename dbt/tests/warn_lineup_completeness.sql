{{ config(severity='warn', tags=['quality', 'lineups']) }}

-- At least 90% of a season's actions have five players a side on the floor. Period starters
-- after the first period are inferred, so a player who plays a whole period without an action
-- or a substitution is missed; a drop below 90% means the substitution format changed.
select league, season, count(*) as actions,
    sum(case when lineup_complete then 1 else 0 end) as complete,
    sum(case when lineup_complete then 1 else 0 end) * 1.0 / count(*) as complete_rate
from {{ ref('fct_event') }}
group by league, season
having count(*) >= 1000
    and sum(case when lineup_complete then 1 else 0 end) * 1.0 / count(*) < 0.9
