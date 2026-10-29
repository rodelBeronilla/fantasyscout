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
    ) as away_matchup
from upcoming as u
left join standardised as h on h.league = u.league and h.season = u.season and h.team_id = u.home_team_id
left join standardised as a on a.league = u.league and a.season = u.season and a.team_id = u.away_team_id
