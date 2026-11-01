{#
  The schedule from each team's side: one row per team per scheduled game, home and away, with
  the opponent and the game's date, type, status and venue flags. Every model that counts a team's
  games (remaining, this week, back-to-backs, stakes, travel) reads this instead of unioning the
  schedule's two sides itself; each keeps its own filters on game type, status and venue.
#}

select
    league,
    season,
    game_id,
    game_date_est,
    game_type,
    game_status,
    if_necessary,
    is_neutral,
    arena_city,
    home_team_id as team_id,
    away_team_id as opponent_id,
    true as is_home
from {{ ref('schedule') }}
union all
select
    league,
    season,
    game_id,
    game_date_est,
    game_type,
    game_status,
    if_necessary,
    is_neutral,
    arena_city,
    away_team_id as team_id,
    home_team_id as opponent_id,
    false as is_home
from {{ ref('schedule') }}
