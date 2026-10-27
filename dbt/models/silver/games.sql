{#
  One row per game: home and away sides folded from the team game log.

  The game log marks a side as home when its matchup reads "vs." and away when it reads "@".
  At a neutral site (league showcase games abroad, a cup final) both teams read "vs.", so the
  sides are ranked per game, home first, then by team id: the two rows always fold into one
  game, and the home side of a neutral-site game is the lower team id, flagged by
  `neutral_site`.
#}

with sides as (

    select
        *,
        row_number() over (
            partition by league, game_id
            order by is_home desc nulls last, team_id
        ) as side_rank
    from {{ ref('team_game_box') }}

),

home as (select * from sides where side_rank = 1),
away as (select * from sides where side_rank = 2)

select
    home.league,
    home.season,
    home.game_id,
    home.league || ':' || home.game_id as game_key,
    home.game_date,
    home.team_id as home_team_id,
    home.team_abbreviation as home_team_abbreviation,
    away.team_id as away_team_id,
    away.team_abbreviation as away_team_abbreviation,
    home.points as home_points,
    away.points as away_points,
    case when home.points > away.points then home.team_id when away.points > home.points then away.team_id end as winner_team_id,
    coalesce(home.is_home, false) = coalesce(away.is_home, false) as neutral_site,
    greatest(home._ingest_date, coalesce(away._ingest_date, home._ingest_date)) as _ingest_date
from home
left join away
    on home.league = away.league and home.game_id = away.game_id
