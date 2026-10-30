{#
  Betting prices, read the same on DuckDB and Databricks.

  american_to_prob(col)  the probability an American price implies, the bookmaker's margin (vig)
                         included: -150 is 150 / 250 = 0.6, +130 is 100 / 230. Null for a missing
                         price or one between -100 and +100, which no American price is.
#}

{% macro american_to_prob(col) -%}
  case
    when {{ col }} >= 100 then 100.0 / ({{ col }} + 100.0)
    when {{ col }} <= -100 then -1.0 * {{ col }} / (-1.0 * {{ col }} + 100.0)
  end
{%- endmacro %}
