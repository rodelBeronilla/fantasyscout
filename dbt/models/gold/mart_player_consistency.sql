{#
  Game-to-game consistency (#747): the spread of a player's game values this season
  (int_player_game_value, on the board's z_total scale). The mean equals the season z_total; the
  floor and ceiling are the 20th and 80th percentile games.
#}

select
    {{ sk(['league', 'season', 'player_id']) }} as consistency_sk,
    league,
    season,
    player_id,
    count(*) as games,
    avg(game_value) as game_value_mean,
    stddev_samp(game_value) as game_value_sd,
    {{ quantile('game_value', 0.2) }} as game_floor,
    {{ quantile('game_value', 0.8) }} as game_ceiling
from {{ ref('int_player_game_value') }}
group by league, season, player_id
