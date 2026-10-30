{{ config(severity='warn', warn_if='>5', tags=['quality']) }}

-- Sleeper's trending players on an NBA team that could not be linked to a current league player
-- (by name, birth date and team). A free agent has no team in Sleeper's directory and is left
-- out; more than a few unlinked means a name form the match does not handle.
select t.league, t.sleeper_player_id, t.sleeper_full_name, t.adds, t.drops
from {{ ref('fct_waiver_trend') }} as t
join {{ ref('waiver_trending') }} as s on s.league = t.league and s.sleeper_player_id = t.sleeper_player_id
where t.stats_player_id is null and s.team_abbreviation is not null
