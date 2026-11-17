{{ config(severity='warn', tags=['player']) }}

-- A player's games scheduled agree with his team's week in fct_team_week_games (#997), in every
-- week that table has (the current week on), for a player on one team all week. Two weeks are
-- left out by design: a week in which a stint of his begins after the Monday (a trade, a signing:
-- each team counts on its own days), and a week in which his team also has a playoff game, which
-- fct_team_week_games counts and a regular-season table does not.
with moved as (

    select distinct w.league, w.player_id, w.week_start
    from {{ ref('fct_player_week') }} as w
    join {{ ref('dim_player') }} as p
        on p.league = w.league and p.stats_player_id = w.player_id
        and p.valid_from > w.week_start and p.valid_from <= w.week_end

),

playoff_weeks as (

    select distinct s.league, s.season, s.team_id, d.week_start
    from {{ ref('schedule_team_games') }} as s
    join {{ ref('dim_date') }} as d on d.date_day = s.game_date_est
    where s.game_type = 'playoffs'

)

select
    w.league,
    w.season,
    w.player_id,
    w.team_id,
    w.week_start,
    w.games_scheduled,
    t.games as team_games
from {{ ref('fct_player_week') }} as w
join {{ ref('fct_team_week_games') }} as t
    on t.league = w.league and t.season = w.season and t.team_id = w.team_id
    and t.week_start = w.week_start
left join moved as m
    on m.league = w.league and m.player_id = w.player_id and m.week_start = w.week_start
left join playoff_weeks as pw
    on pw.league = w.league and pw.season = w.season and pw.team_id = w.team_id
    and pw.week_start = w.week_start
where m.player_id is null
    and pw.team_id is null
    and w.games_scheduled <> t.games
