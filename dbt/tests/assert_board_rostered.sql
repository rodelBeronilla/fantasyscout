{{ config(severity='error', tags=['quality', 'board']) }}

-- Every board player is on their team's latest roster landing for the league's latest roster
-- season: no retired, released or waived players.
with latest as (
    select league, season, team_id, player_id
    from {{ ref('rosters') }}
    qualify season = max(season) over (partition by league)
        and _ingest_date = max(_ingest_date) over (partition by league, season, team_id)
)
select b.league, b.player_id, b.full_name
from {{ ref('mart_board') }} as b
left join latest as l on l.league = b.league and l.player_id = b.player_id
where l.player_id is null
