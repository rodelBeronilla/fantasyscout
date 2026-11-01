{#
  Games per team per fantasy week (Monday to Sunday, dim_date.fantasy_week), from the current
  week to the last scheduled game: the schedule surface a fantasy manager plans the playoff weeks
  on, which team plays four times and which plays two. Regular-season and playoff games, from
  each team's side of the schedule (silver.schedule_team_games); an if-necessary playoff game is
  counted apart. games counts the week's games played or not, games_left the ones still to play
  from today; game_dates lists every date, if-necessary games included.
#}

with sides as (

    select
        s.league,
        s.season,
        s.team_id,
        s.game_date_est,
        s.game_status,
        coalesce(s.if_necessary, false) as if_necessary
    from {{ ref('schedule_team_games') }} as s
    where s.game_type in ('regular', 'playoffs')
        and s.game_date_est >= {{ week_start(as_of_date()) }}

),

weeks as (

    select date_day, week_start, fantasy_week
    from {{ ref('dim_date') }}

)

select
    {{ sk(['s.league', 's.season', 's.team_id', 'w.fantasy_week']) }} as team_week_sk,
    s.league,
    s.season,
    s.team_id,
    t.abbreviation as team_abbreviation,
    w.fantasy_week,
    w.week_start,
    {{ add_days('w.week_start', 6) }} as week_end,
    w.week_start = {{ week_start(as_of_date()) }} as is_current_week,
    cast(sum(case when not s.if_necessary then 1 else 0 end) as integer) as games,
    cast(sum(case when not s.if_necessary and s.game_status <> 3 and s.game_date_est >= {{ as_of_date() }} then 1 else 0 end) as integer) as games_left,
    cast(sum(case when s.if_necessary then 1 else 0 end) as integer) as games_if_necessary,
    {{ sorted_join('cast(s.game_date_est as string)') }} as game_dates
from sides as s
join weeks as w on w.date_day = s.game_date_est
left join {{ ref('team_current') }} as t on t.league = s.league and t.team_id = s.team_id
group by s.league, s.season, s.team_id, t.abbreviation, w.fantasy_week, w.week_start
