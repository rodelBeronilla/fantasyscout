{#
  What each team still has to play for in its current regular season, from the league standings:
  - stakes: eliminated (out of the playoff and play-in race), clinched (a playoff place is
    secured), or racing;
  - games_left: regular-season games still to play;
  - rest_risk: a team with nothing left to play for in the last stretch (10 or fewer games in the
    NBA, 6 in the WNBA). A clinched team rests its stars; an eliminated one plays its young
    players. Either way, a regular's minutes are less certain.
#}

with current_season as (

    select league, max(season) as season from {{ ref('standings') }} group by league

),

remaining as (

    select league, season, team_id, count(*) as games_left
    from (
        select league, season, home_team_id as team_id, game_type, game_status, game_date_est from {{ ref('schedule') }}
        union all
        select league, season, away_team_id, game_type, game_status, game_date_est from {{ ref('schedule') }}
    ) as sides
    where game_type = 'regular' and game_status <> 3 and game_date_est >= {{ eastern_today() }}
    group by league, season, team_id

)

select
    {{ sk(['s.league', 's.season', 's.team_id']) }} as team_stakes_sk,
    s.league,
    s.season,
    s.team_id,
    s.conference,
    s.playoff_rank,
    s.wins,
    s.losses,
    s.conference_games_back,
    s.last_10,
    s.current_streak,
    case
        when s.eliminated then 'eliminated'
        when s.clinched_playoffs then 'clinched'
        else 'racing'
    end as stakes,
    coalesce(r.games_left, 0) as games_left,
    (s.eliminated or s.clinched_playoffs)
        and coalesce(r.games_left, 0) > 0
        and coalesce(r.games_left, 0) <= case s.league when 'nba' then 10 else 6 end as rest_risk,
    s.observed_date
from {{ ref('standings') }} as s
join current_season as cs on cs.league = s.league and cs.season = s.season
left join remaining as r on r.league = s.league and r.season = s.season and r.team_id = s.team_id
