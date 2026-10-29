{#
  A per-league fantasy setting from the `fantasy` var as a SQL expression on a league column:
  teams, roster_spots, prior_games, or pool_size (teams x roster spots).
#}
{% macro fantasy_setting(key, league_col='league') -%}
  {%- set settings = var('fantasy') -%}
  case {{ league_col }}
  {%- for league, s in settings.items() %}
    when '{{ league }}' then {{ s['teams'] * s['roster_spots'] if key == 'pool_size' else s[key] }}
  {%- endfor %}
  end
{%- endmacro %}

{# The recency weight of a season by its rank (1 = current season, 2 = the one before, ...). #}
{% macro fantasy_recency(rank_col) -%}
  {%- set w = var('fantasy_recency') -%}
  case {{ rank_col }}
  {%- for weight in w %}
    when {{ loop.index }} then {{ weight }}
  {%- endfor %}
    else 0
  end
{%- endmacro %}
