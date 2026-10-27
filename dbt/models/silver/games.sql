{# One row per game: home and away sides folded from the team game log. #}

with sides as (

    select * from {{ ref('team_game_box') }}

),

home as (select * from sides where is_home),
away as (select * from sides where not is_home)

select
    coalesce(home.league, away.league) as league,
    coalesce(home.season, away.season) as season,
    coalesce(home.game_id, away.game_id) as game_id,
    coalesce(home.league, away.league) || ':' || coalesce(home.game_id, away.game_id) as game_key,
    coalesce(home.game_date, away.game_date) as game_date,
    home.team_id as home_team_id,
    home.team_abbreviation as home_team_abbreviation,
    away.team_id as away_team_id,
    away.team_abbreviation as away_team_abbreviation,
    home.points as home_points,
    away.points as away_points,
    case when home.points > away.points then home.team_id when away.points > home.points then away.team_id end as winner_team_id,
    greatest(coalesce(home._ingest_date, away._ingest_date), coalesce(away._ingest_date, home._ingest_date)) as _ingest_date
from home
full outer join away
    on home.league = away.league and home.game_id = away.game_id
