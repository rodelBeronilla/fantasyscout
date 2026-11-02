{{ config(severity='warn', tags=['quality', 'lineups']) }}

-- A season's actions with five players a side on the floor reach the good bound of
-- vars.quality_thresholds.lineup_complete (90%). Period starters after the first period are
-- inferred, so a player who plays a whole period without an action or a substitution is missed;
-- a drop below it means the substitution format changed.
select league, season, count(*) as actions,
    sum(case when lineup_complete then 1 else 0 end) as complete,
    sum(case when lineup_complete then 1 else 0 end) * 1.0 / count(*) as complete_rate
from {{ ref('fct_event') }}
group by league, season
having count(*) >= 1000
    and sum(case when lineup_complete then 1 else 0 end) * 1.0 / count(*) < {{ var('quality_thresholds')['lineup_complete'][0] }}
