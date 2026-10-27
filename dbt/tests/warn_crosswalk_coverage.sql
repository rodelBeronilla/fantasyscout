{{ config(severity='warn', tags=['quality', 'reconciliation']) }}

-- At least 99% of a season's played player-games are matched to ESPN through the crosswalk
-- (SPEC.md phase 4). The league lists inactive players with a line of zeros that ESPN does
-- not carry, so the rate is judged over players who were on the floor. Seasons with fewer
-- than 100 played player-games are too small to judge.
select
    league,
    season,
    played_player_games,
    played_matched,
    played_match_rate,
    match_rate
from {{ ref('reconciliation_summary') }}
where played_player_games >= 100
    and played_match_rate < 0.99
