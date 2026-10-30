{{ config(severity='warn', warn_if='>5', tags=['quality']) }}

-- Players on the league's newest injury report, for upcoming games, that could not be linked to a
-- league player id (by name within the team). A few two-way or newly signed players are expected;
-- more means a team name or a name form the link does not handle.
select o.league, o.team, o.player_name, o.status, o.game_date
from {{ ref('official_injury_report') }} as o
left join {{ ref('fct_player_status') }} as s
    on s.league = o.league and s.official_game_date = o.game_date and s.official_status = o.status
    and s.official_reason = o.reason
where o.is_latest and not o.not_submitted and o.player_name is not null
    and o.game_date >= {{ eastern_today() }}
    and s.stats_player_id is null
