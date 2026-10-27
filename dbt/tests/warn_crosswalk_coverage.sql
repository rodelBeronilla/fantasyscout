{{ config(severity='warn', tags=['quality', 'reconciliation']) }}

-- At least 99% of a season's player-games are matched to ESPN through the crosswalk
-- (SPEC.md phase 4). Seasons with fewer than 100 player-games are too small to judge.
select
    league,
    season,
    player_games,
    matched,
    unmatched,
    match_rate
from {{ ref('reconciliation_summary') }}
where player_games >= 100
    and match_rate < 0.99
