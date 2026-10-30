{#
  Game × official: who officiated each game, and who is assigned to the day's games (silver
  game_officials). Played games carry ESPN's crew, with each official's role where the leagues'
  assignments page named them; the day's games carry the page's crew until ESPN lists one.
#}

select
    {{ sk(['league', 'game_id', 'official_key']) }} as game_official_sk,
    {{ sk(['league', 'game_id']) }} as game_sk,
    game_official_key,
    league,
    season,
    game_id,
    game_date,
    official_key,
    official_name,
    role,
    uniform_number,
    listed_order,
    source
from {{ ref('game_officials') }}
