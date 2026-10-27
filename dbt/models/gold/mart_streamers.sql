{#
  Streaming candidates: one row per player on a current roster with the team's games in the
  next seven days and the minutes trend (last 5 games vs last 20).
#}

with upcoming as (

    select league, season, team_id, count(*) as games_next_7
    from (
        select league, season, home_team_id as team_id, game_date_est, game_status from {{ ref('schedule') }}
        union all
        select league, season, away_team_id as team_id, game_date_est, game_status from {{ ref('schedule') }}
    ) as sides
    where game_status <> 3
        and game_date_est >= {{ as_of_date() }}
        and game_date_est < {{ add_days(as_of_date(), 7) }}
    group by league, season, team_id

),

latest_rolling as (

    select *
    from {{ ref('mart_player_rolling') }}
    qualify row_number() over (partition by league, player_id order by game_date desc, game_id desc) = 1

),

current_stint as (

    select league, stats_player_id, player_sk, team_id, full_name, position
    from {{ ref('dim_player') }}
    where is_current

)

select
    {{ sk(['cs.league', 'cs.stats_player_id']) }} as streamer_sk,
    cs.league,
    cs.stats_player_id as player_id,
    cs.player_sk,
    cs.full_name,
    cs.position,
    cs.team_id,
    lr.season,
    coalesce(u.games_next_7, 0) as games_next_7,
    lr.game_date as last_game_date,
    lr.minutes_avg_5,
    lr.minutes_avg_20,
    lr.minutes_avg_5 - lr.minutes_avg_20 as minutes_trend,
    lr.points_avg_5,
    lr.rebounds_total_avg_5,
    lr.assists_avg_5,
    lr.games_in_window_20
from current_stint as cs
left join latest_rolling as lr on lr.league = cs.league and lr.player_id = cs.stats_player_id
left join upcoming as u on u.league = cs.league and u.season = lr.season and u.team_id = cs.team_id
