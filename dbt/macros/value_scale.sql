{#
  One value scale (#767, ADR 0019). int_value_scale holds, per league and season, the pool's
  category means, spreads, shooting percentages and the replacement level; these macros score a
  line on it, so the season, the last twenty and ten games, a single game and the projection are
  all value per game above the league's replacement level, in the same units.
#}

{# The categories the scale covers, in the board's order. #}
{% macro value_counting() -%}
  {{ return(['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers']) }}
{%- endmacro %}

{% macro value_categories() -%}
  {{ return(value_counting() + ['field_goal_pct', 'free_throw_pct']) }}
{%- endmacro %}

{# A regular-season game: the third character of a league game id is 2 (fantasy windows count no other). #}
{% macro is_regular_season(game_id_col='game_id') -%}
  substr({{ game_id_col }}, 3, 1) = '2'
{%- endmacro %}

{#
  One category's score on the scale `s` (an int_value_scale row): `stat` maps each counting
  category, and fgm, fga, ftm, fta, to the SQL for its per-game number. Counting categories are
  (x - pool mean) / pool sd, turnovers negative; shooting is makes above the pool's percentage on
  the attempts, over the pool's spread of that impact. With `above_replacement` the category's
  replacement level is subtracted. A missing number scores zero, as the board always has.
#}
{% macro scale_score(category, stat, s, above_replacement=true) -%}
  {%- if category == 'field_goal_pct' -%}
    coalesce(({{ stat['fgm'] }} - {{ s }}.pool_field_goal_pct * {{ stat['fga'] }}) / nullif({{ s }}.sd_fg_impact, 0), 0)
  {%- elif category == 'free_throw_pct' -%}
    coalesce(({{ stat['ftm'] }} - {{ s }}.pool_free_throw_pct * {{ stat['fta'] }}) / nullif({{ s }}.sd_ft_impact, 0), 0)
  {%- else -%}
    {% if category == 'turnovers' %}-{% endif %}coalesce(({{ stat[category] }} - {{ s }}.mean_{{ category }}) / nullif({{ s }}.sd_{{ category }}, 0), 0)
  {%- endif -%}
  {%- if above_replacement %} - {{ s }}.repl_z_{{ category }}{% endif -%}
{%- endmacro %}

{# The nine z columns of a line (z_points ... z_free_throw_pct), comma separated. #}
{% macro scale_z_columns(stat, s, prefix='z_') -%}
  {%- for c in value_categories() %}
    {{ scale_score(c, stat, s) }} as {{ prefix }}{{ c }}{{ "," if not loop.last }}
  {%- endfor %}
{%- endmacro %}

{# The sum of the nine, the value per game above replacement. #}
{% macro scale_total(stat, s) -%}
  {%- for c in value_categories() %}({{ scale_score(c, stat, s) }}){{ " + " if not loop.last }}{% endfor %}
{%- endmacro %}

{# The per-game columns of a line whose columns are <category>_pg, fgm_pg, fga_pg, ftm_pg, fta_pg. #}
{% macro pg_stat(alias, prefix='', suffix='_pg') -%}
  {%- set out = {} -%}
  {%- for c in value_counting() + ['fgm', 'fga', 'ftm', 'fta'] -%}
    {%- do out.update({c: alias ~ '.' ~ prefix ~ c ~ suffix}) -%}
  {%- endfor -%}
  {{ return(out) }}
{%- endmacro %}
