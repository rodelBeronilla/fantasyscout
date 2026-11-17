{#
  Player × fantasy week (#997): a head-to-head category manager's grain. One row per league,
  season, fantasy week and player, for every week in which the player has a regular-season box
  score row (fct_player_game), played or not. Regular-season games only (the third character of
  the game id is 2), the games fantasy leagues score and the week-by-week harness counts; the
  playoffs, the play-in and the NBA Cup final are left out.

  The week is dim_date's: Monday to Sunday, labelled by fantasy_week and keyed by its Monday. It is
  the week the harness sums (ops.closeness_backtest's week_days start at the first game day and
  then every Monday, but each is summed by its Monday, so the season's first week is its first
  game day to that Sunday, a partial week of the same calendar week).

  The nine categories are totals, the two percentages kept as makes and attempts, never as ratios.
  A number missing from a game counts as zero, so a week's totals add up to fct_player_game's for
  the season exactly. games_played counts the games with minutes. games_scheduled counts the
  regular-season games on the schedule of the team the player was on each day (dim_player's
  stints), played or not, if-necessary games left out: a player traded mid-week counts his old
  team's games before the move and his new team's from it. team_id is the team of his last game
  of the week. A build as of a date (ADR 0018) sees the games played before it, and the whole
  week's schedule, as fct_team_week_games does.
#}

with games as (

    select
        g.league,
        g.season,
        g.player_id,
        g.team_id,
        g.game_id,
        g.game_date,
        w.fantasy_week,
        w.week_start,
        g.played,
        g.minutes,
        g.points,
        g.rebounds_total,
        g.assists,
        g.steals,
        g.blocks,
        g.three_pointers_made,
        g.turnovers,
        g.field_goals_made,
        g.field_goals_attempted,
        g.free_throws_made,
        g.free_throws_attempted
    from {{ ref('fct_player_game') }} as g
    join {{ ref('dim_date') }} as w on w.date_day = g.game_date
    where {{ is_regular_season('g.game_id') }}

),

totals as (

    select
        league,
        season,
        player_id,
        fantasy_week,
        week_start,
        cast(sum(case when played then 1 else 0 end) as integer) as games_played,
        coalesce(sum(minutes), 0) as minutes,
        {%- for c in ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'field_goals_made', 'field_goals_attempted', 'free_throws_made', 'free_throws_attempted'] %}
        coalesce(sum({{ c }}), 0) as {{ c }}{{ "," if not loop.last }}
        {%- endfor %}
    from games
    group by league, season, player_id, fantasy_week, week_start

),

last_team as (

    select league, season, player_id, week_start, team_id
    from games
    qualify row_number() over (
        partition by league, season, player_id, week_start order by game_date desc, game_id desc
    ) = 1

),

scheduled as (

    -- each day of the week counts the games of the team his stint puts him on that day
    select
        t.league,
        t.season,
        t.player_id,
        t.week_start,
        cast(count(*) as integer) as games_scheduled
    from totals as t
    join {{ ref('dim_player') }} as p
        on p.league = t.league and p.stats_player_id = t.player_id
        and p.valid_from <= {{ add_days('t.week_start', 6) }}
        and (p.valid_to is null or p.valid_to >= t.week_start)
    join {{ ref('schedule_team_games') }} as s
        on s.league = t.league and s.season = t.season and s.team_id = p.team_id
        and s.game_type = 'regular' and not coalesce(s.if_necessary, false)
        and s.game_date_est >= t.week_start and s.game_date_est <= {{ add_days('t.week_start', 6) }}
        and s.game_date_est >= p.valid_from and (p.valid_to is null or s.game_date_est <= p.valid_to)
    group by t.league, t.season, t.player_id, t.week_start

)

select
    {{ sk(['t.league', 't.season', 't.player_id', 't.fantasy_week']) }} as player_week_sk,
    t.league,
    t.season,
    t.player_id,
    lt.team_id,
    t.fantasy_week,
    t.week_start,
    {{ add_days('t.week_start', 6) }} as week_end,
    coalesce(s.games_scheduled, 0) as games_scheduled,
    t.games_played,
    t.minutes,
    t.points,
    t.rebounds_total,
    t.assists,
    t.steals,
    t.blocks,
    t.three_pointers_made,
    t.turnovers,
    t.field_goals_made,
    t.field_goals_attempted,
    t.free_throws_made,
    t.free_throws_attempted
from totals as t
left join last_team as lt
    on lt.league = t.league and lt.season = t.season and lt.player_id = t.player_id
    and lt.week_start = t.week_start
left join scheduled as s
    on s.league = t.league and s.season = t.season and s.player_id = t.player_id
    and s.week_start = t.week_start
