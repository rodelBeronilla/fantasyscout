{#
  The games of the next fourteen days per league, for the Streamers week grid and the board's
  games-next-seven column. Only regular-season and playoff games count, and an "if necessary"
  playoff game is left out until it is confirmed (the league stops flagging it once it is on).

  Each side of a game carries a matchup value: how much a player's value per game moves with
  the opponent's defence and the game's expected pace, from replaying past seasons (ADR 0003:
  one standard deviation of opponent defence is worth about 0.2 value per game in the NBA,
  against a game-to-game swing of about 2.5; var fantasy_matchup). A team's defensive rating
  and pace blend this season to date with last season, last season counting as prior_games
  games, so early in a season (and for a reworked roster) the current games take over as they
  accumulate; early on, last season's team defence was the better guide. Ratings are
  standardised over the league's teams. A player's past results against an opponent predicted
  nothing (correlation 0.00 to 0.04) and are not used.

  Each game also carries its betting line where the sportsbooks have posted one (silver
  game_lines): the home spread, the over/under, and the points each side is implied to score.
  The line is shown alongside the matchup value and does not change it until a backtest says it
  adds to it.
#}

{% set m = var('fantasy_matchup') %}
{% set k = m['prior_games'] %}

with upcoming as (

    select
        s.league,
        s.season,
        s.game_id,
        s.game_date_est as game_date,
        {{ days_between(as_of_date(), 's.game_date_est') }} as days_ahead,
        s.game_type,
        s.home_team_id,
        s.home_team_tricode,
        s.away_team_id,
        s.away_team_tricode,
        s.game_datetime_utc
    from {{ ref('schedule') }} as s
    where s.game_status <> 3
        and s.game_type in ('regular', 'playoffs')
        and not coalesce(s.if_necessary, false)
        and s.game_date_est >= {{ as_of_date() }}
        and s.game_date_est < {{ add_days(as_of_date(), 14) }}

),

team_ratings as (

    select league, season, team_id, count(*) as games, avg(defensive_rating) as def_rating, avg(pace) as pace
    from {{ ref('fct_team_game') }}
    group by league, season, team_id

),

upcoming_seasons as (

    select distinct league, season from upcoming

),

previous_season as (

    select u.league, u.season, max(r.season) as prev_season
    from upcoming_seasons as u
    join team_ratings as r on r.league = u.league and r.season < u.season
    group by u.league, u.season

),

teams as (

    select distinct league, season, home_team_id as team_id from upcoming
    union
    select distinct league, season, away_team_id as team_id from upcoming

),

blended as (

    select
        t.league,
        t.season,
        t.team_id,
        (coalesce(c.games, 0) * coalesce(c.def_rating, 0) + {{ k }} * coalesce(l.def_rating, c.def_rating, 0))
            / nullif(coalesce(c.games, 0) + case when coalesce(l.def_rating, c.def_rating) is null then 0 else {{ k }} end, 0) as def_rating,
        (coalesce(c.games, 0) * coalesce(c.pace, 0) + {{ k }} * coalesce(l.pace, c.pace, 0))
            / nullif(coalesce(c.games, 0) + case when coalesce(l.pace, c.pace) is null then 0 else {{ k }} end, 0) as pace
    from teams as t
    left join team_ratings as c on c.league = t.league and c.season = t.season and c.team_id = t.team_id
    left join previous_season as p on p.league = t.league and p.season = t.season
    left join team_ratings as l on l.league = t.league and l.season = p.prev_season and l.team_id = t.team_id

),

standardised as (

    select
        *,
        (def_rating - avg(def_rating) over (partition by league, season))
            / nullif(stddev_samp(def_rating) over (partition by league, season), 0) as def_z,
        (pace - avg(pace) over (partition by league, season))
            / nullif(stddev_samp(pace) over (partition by league, season), 0) as pace_z
    from blended

),

lines as (

    select
        gl.league,
        gl.event_date_et,
        th.stats_team_id as home_team_id,
        ta.stats_team_id as away_team_id,
        gl.home_spread,
        gl.over_under,
        gl.home_implied_points,
        gl.away_implied_points,
        gl.provider,
        gl.observed_date
    from {{ ref('game_lines') }} as gl
    join {{ ref('team_xwalk') }} as th on th.league = gl.league and th.espn_team_id = gl.espn_home_team_id
    join {{ ref('team_xwalk') }} as ta on ta.league = gl.league and ta.espn_team_id = gl.espn_away_team_id
    where gl.event_date_et >= {{ add_days(as_of_date(), -1) }}

)

select
    {{ sk(['u.league', 'u.game_id']) }} as upcoming_sk,
    u.league,
    u.season,
    u.game_id,
    u.game_date,
    u.days_ahead,
    u.game_type,
    u.home_team_id,
    u.home_team_tricode,
    u.away_team_id,
    u.away_team_tricode,
    u.game_datetime_utc,
    -- for the home side: the away team's defence (a higher rating allows more) and the pace of both
    coalesce(
        case u.league {% for lg, b in m.items() if lg != 'prior_games' %} when '{{ lg }}' then {{ b['defense'] }} * coalesce(a.def_z, 0) + {{ b['pace'] }} * (coalesce(h.pace_z, 0) + coalesce(a.pace_z, 0)) / 2{% endfor %} end,
        0
    ) as home_matchup,
    coalesce(
        case u.league {% for lg, b in m.items() if lg != 'prior_games' %} when '{{ lg }}' then {{ b['defense'] }} * coalesce(h.def_z, 0) + {{ b['pace'] }} * (coalesce(h.pace_z, 0) + coalesce(a.pace_z, 0)) / 2{% endfor %} end,
        0
    ) as away_matchup,
    -- The line, from the event listed the same way round or, at a neutral site, the other way.
    coalesce(ls.home_spread, -lf.home_spread) as home_spread,
    coalesce(ls.over_under, lf.over_under) as over_under,
    coalesce(ls.home_implied_points, lf.away_implied_points) as home_implied_points,
    coalesce(ls.away_implied_points, lf.home_implied_points) as away_implied_points,
    coalesce(ls.provider, lf.provider) as line_provider,
    coalesce(ls.observed_date, lf.observed_date) as line_as_of,
    -- Rest and travel (fct_team_game_context): shown beside the matchup, not yet in it.
    hc.rest_days as home_rest_days,
    coalesce(hc.is_back_to_back, false) as home_back_to_back,
    ac.rest_days as away_rest_days,
    coalesce(ac.is_back_to_back, false) as away_back_to_back,
    ac.miles_travelled as away_miles_travelled,
    coalesce(hc.at_altitude, false) as at_altitude
from upcoming as u
left join standardised as h on h.league = u.league and h.season = u.season and h.team_id = u.home_team_id
left join standardised as a on a.league = u.league and a.season = u.season and a.team_id = u.away_team_id
left join {{ ref('fct_team_game_context') }} as hc
    on hc.league = u.league and hc.game_id = u.game_id and hc.team_id = u.home_team_id
left join {{ ref('fct_team_game_context') }} as ac
    on ac.league = u.league and ac.game_id = u.game_id and ac.team_id = u.away_team_id
left join lines as ls
    on ls.league = u.league and ls.event_date_et = u.game_date
    and ls.home_team_id = u.home_team_id and ls.away_team_id = u.away_team_id
left join lines as lf
    on lf.league = u.league and lf.event_date_et = u.game_date
    and lf.home_team_id = u.away_team_id and lf.away_team_id = u.home_team_id
