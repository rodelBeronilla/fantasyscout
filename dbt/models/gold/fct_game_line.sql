{#
  The betting line for each played game: ESPN's closing line from the game summary (or the last
  scoreboard line when the summary had none), linked to the league's game id through the game
  crosswalk, with the points each team was implied to score. Upcoming games' lines are in
  mart_schedule_upcoming; this table is the history, for analyses of what the line said against
  what happened.
#}

select
    {{ sk(['x.league', 'x.game_id']) }} as game_line_sk,
    x.league,
    x.season,
    x.game_id,
    x.game_date,
    th.stats_team_id as home_team_id,
    ta.stats_team_id as away_team_id,
    gl.home_spread,
    gl.over_under,
    gl.home_implied_points,
    gl.away_implied_points,
    gl.home_moneyline,
    gl.away_moneyline,
    gl.line_type,
    gl.provider,
    gl.observed_date
from {{ ref('game_lines') }} as gl
join {{ ref('game_xwalk') }} as x on x.league = gl.league and x.event_id = gl.event_id
left join {{ ref('team_xwalk') }} as th on th.league = gl.league and th.espn_team_id = gl.espn_home_team_id
left join {{ ref('team_xwalk') }} as ta on ta.league = gl.league and ta.espn_team_id = gl.espn_away_team_id
