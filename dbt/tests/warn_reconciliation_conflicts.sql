{{ config(severity='warn', tags=['quality', 'reconciliation']) }}

-- Of the player-games the league and ESPN both report, at most 0.5% may disagree beyond rounding
-- (vars.quality_thresholds.conflict_rate, the good bound; the data-quality notebook grades against
-- the same pair). A season with fewer than 100 matched player-games is too small to judge (#392).
select
    league,
    season,
    matched,
    conflict,
    conflict_rate
from {{ ref('reconciliation_summary') }}
where matched >= 100
    and conflict_rate > {{ var('quality_thresholds')['conflict_rate'][0] }}
