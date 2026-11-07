{#
  A continuous quantile of an aggregate expression (#747): quantile(x, 0.2) is the 20th
  percentile, interpolated between the two nearest values, on either engine.
#}
{% macro quantile(expr, q) -%}
  {{ return(adapter.dispatch('quantile', 'fantasyscout')(expr, q)) }}
{%- endmacro %}

{% macro default__quantile(expr, q) -%}
  quantile_cont({{ expr }}, {{ q }})
{%- endmacro %}

{% macro databricks__quantile(expr, q) -%}
  percentile({{ expr }}, {{ q }})
{%- endmacro %}
