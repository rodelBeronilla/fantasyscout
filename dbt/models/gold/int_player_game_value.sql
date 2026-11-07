{#
  Every regular-season game played, valued on the season's value scale (#747, #767, ADR 0019):
  the sum of the game's nine category scores against int_value_scale's pool, each less the
  category's replacement level, the same scale the board's value and the windows use. Counting
  categories are (stat - pool mean) / pool sd, turnovers negative; the percentages are the
  game's makes above the pool's percentage on its attempts, over the pool's impact sd. The scale
  is linear in a game's numbers, so a player's mean game value is their season value per game
  (mart_category_zscores' season z_total). mart_player_consistency reads it for a player's
  spread.
#}

{#- a missing number in a game played counts as zero, as int_player_window_lines averages it -#}
{%- set stat = {
    'points': 'coalesce(g.points, 0)', 'rebounds_total': 'coalesce(g.rebounds_total, 0)',
    'assists': 'coalesce(g.assists, 0)', 'steals': 'coalesce(g.steals, 0)', 'blocks': 'coalesce(g.blocks, 0)',
    'three_pointers_made': 'coalesce(g.three_pointers_made, 0)', 'turnovers': 'coalesce(g.turnovers, 0)',
    'fgm': 'coalesce(g.field_goals_made, 0)', 'fga': 'coalesce(g.field_goals_attempted, 0)',
    'ftm': 'coalesce(g.free_throws_made, 0)', 'fta': 'coalesce(g.free_throws_attempted, 0)'} %}

select
    g.league,
    g.season,
    g.game_id,
    g.game_date,
    g.team_id,
    g.player_id,
    g.player_sk,
    g.minutes,
    {{ scale_total(stat, 's') }} as game_value
from {{ ref('fct_player_game') }} as g
join {{ ref('int_value_scale') }} as s on s.league = g.league and s.season = g.season
where g.played and {{ is_regular_season('g.game_id') }}
