{#
  Where each league stands today, in one place. The gold models used to decide "the current
  season" and "in season" each in their own way; the definitions now live here, named for what
  they mean, and each model says which one it reads:

  - games_season: the latest season with a game in gold (mart_streamers' season).
  - zscores_season: the latest season with a season line in mart_category_zscores (the
    projection's season; equal to games_season once a season's first games are in).
  - standings_season: the latest season the league has published standings for (fct_team_stakes).
    In the preseason this can already be the new season while the games season is last year's.
  - schedule_season: the latest season on the schedule.
  - in_season_window: a scheduled game within three days either side of today (ops.feed_freshness:
    a quiet feed is expected outside it).
  - regular_games_left: the zscores season still has regular-season games to play (the
    projection's in-season switch for the recent-form blend).
#}

with leagues as (

    select distinct league from {{ ref('schedule') }}

),

games as (

    select league, max(season) as games_season from {{ ref('fct_player_game') }} group by league

),

zscores as (

    select league, max(season) as zscores_season from {{ ref('mart_category_zscores') }} group by league

),

standings as (

    select league, max(season) as standings_season from {{ ref('standings') }} group by league

),

schedule as (

    select league, max(season) as schedule_season from {{ ref('schedule') }} group by league

),

window_games as (

    select league, true as in_season_window
    from {{ ref('schedule') }}
    where game_date_est >= {{ add_days(eastern_today(), -3) }}
        and game_date_est <= {{ add_days(eastern_today(), 3) }}
    group by league

),

regular_left as (

    select s.league, true as regular_games_left
    from {{ ref('schedule') }} as s
    join zscores as z on z.league = s.league and z.zscores_season = s.season
    where s.game_type = 'regular' and s.game_status <> 3 and s.game_date_est >= {{ as_of_date() }}
    group by s.league

)

select
    l.league,
    g.games_season,
    z.zscores_season,
    st.standings_season,
    sc.schedule_season,
    coalesce(w.in_season_window, false) as in_season_window,
    coalesce(r.regular_games_left, false) as regular_games_left,
    {{ as_of_date() }} as as_of_date
from leagues as l
left join games as g on g.league = l.league
left join zscores as z on z.league = l.league
left join standings as st on st.league = l.league
left join schedule as sc on sc.league = l.league
left join window_games as w on w.league = l.league
left join regular_left as r on r.league = l.league
