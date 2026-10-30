{#
  Official × league-season: the regular-season games an official worked and how those games
  went against the league-season's average game. A game's figures are both teams' together
  (fct_team_game): personal fouls, free-throw attempts and points, and the pace of the game
  (the two teams' average possessions per regulation game). A delta is the official's average
  game less the league-season's average game; a crew's tendency (mart_schedule_upcoming)
  averages its officials'.

  Season aggregates, not point-in-time: an official's row counts every game of the season, the
  ones after a given game included. The out-of-sample test of whether a crew's tendency says
  anything about a player's game (notebook 03, ADR 0003) works from each official's earlier
  games only. An alternate who did not work the game is not counted.
#}

with games as (

    select
        league,
        season,
        game_id,
        sum(fouls_personal) as total_fouls,
        sum(free_throws_attempted) as total_free_throws_attempted,
        avg(pace) as pace,
        sum(points) as total_points
    from {{ ref('fct_team_game') }}
    where substr(game_id, 3, 1) = '2'
    group by league, season, game_id
    having count(*) = 2

),

league_season as (

    select
        league,
        season,
        count(*) as league_games,
        avg(total_fouls) as league_fouls,
        avg(total_free_throws_attempted) as league_free_throws_attempted,
        avg(pace) as league_pace,
        avg(total_points) as league_points
    from games
    group by league, season

),

worked as (

    select distinct
        o.league,
        o.official_key,
        g.season,
        g.game_id,
        g.total_fouls,
        g.total_free_throws_attempted,
        g.pace,
        g.total_points,
        o.role = 'crew_chief' as as_crew_chief
    from {{ ref('fct_game_official') }} as o
    join games as g on g.league = o.league and g.game_id = o.game_id
    where coalesce(o.role, '') <> 'alternate'

),

names as (

    select league, official_key, official_name
    from {{ ref('fct_game_official') }}
    qualify row_number() over (
        partition by league, official_key
        order by case when role is null then 1 else 0 end, game_date desc, game_id desc
    ) = 1

),

per_official as (

    select
        league,
        season,
        official_key,
        count(*) as games_worked,
        sum(case when as_crew_chief then 1 else 0 end) as games_as_crew_chief,
        avg(total_fouls) as avg_fouls,
        avg(total_free_throws_attempted) as avg_free_throws_attempted,
        avg(pace) as avg_pace,
        avg(total_points) as avg_points
    from worked
    group by league, season, official_key

)

select
    {{ sk(['p.league', 'p.season', 'p.official_key']) }} as referee_tendency_sk,
    p.league,
    p.season,
    p.official_key,
    n.official_name,
    p.games_worked,
    p.games_as_crew_chief,
    l.league_games,
    p.avg_fouls,
    p.avg_free_throws_attempted,
    p.avg_pace,
    p.avg_points,
    l.league_fouls,
    l.league_free_throws_attempted,
    l.league_pace,
    l.league_points,
    p.avg_fouls - l.league_fouls as fouls_delta,
    p.avg_free_throws_attempted - l.league_free_throws_attempted as free_throws_attempted_delta,
    p.avg_pace - l.league_pace as pace_delta,
    p.avg_points - l.league_points as points_delta
from per_official as p
join league_season as l on l.league = p.league and l.season = p.season
left join names as n on n.league = p.league and n.official_key = p.official_key
