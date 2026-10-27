{#
  JSON access that reads the same on DuckDB and Databricks.

  json_text(col, path)  one scalar as text (NULL for JSON null or a missing path)
  json_rows(col, path)  a generator: one row per element of the array at path, each as JSON text
  sha256(col)           hex digest, matching the sidecar's sha256
#}

{% macro json_text(col, path) -%}
  {{ return(adapter.dispatch('json_text', 'fantasyscout')(col, path)) }}
{%- endmacro %}

{% macro default__json_text(col, path) -%}
  json_extract_string({{ col }}, '{{ path }}')
{%- endmacro %}

{% macro databricks__json_text(col, path) -%}
  get_json_object({{ col }}, '{{ path }}')
{%- endmacro %}


{% macro json_rows(col, path) -%}
  {{ return(adapter.dispatch('json_rows', 'fantasyscout')(col, path)) }}
{%- endmacro %}

{% macro default__json_rows(col, path) -%}
  unnest(cast(json_extract({{ col }}, '{{ path }}') as json[]))
{%- endmacro %}

{% macro databricks__json_rows(col, path) -%}
  explode(from_json(get_json_object({{ col }}, '{{ path }}'), 'array<string>'))
{%- endmacro %}


{% macro sha256(col) -%}
  {{ return(adapter.dispatch('sha256', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__sha256(col) -%}
  sha256({{ col }})
{%- endmacro %}

{% macro databricks__sha256(col) -%}
  sha2({{ col }}, 256)
{%- endmacro %}


{#
  Minutes come as "28:40" (v3 box scores) or "23" (ESPN). Return decimal minutes.
#}
{% macro minutes_to_decimal(col) -%}
  case
    when {{ col }} is null or {{ col }} = '' then null
    when position(':' in {{ col }}) > 0
      then try_cast(split_part({{ col }}, ':', 1) as double)
           + try_cast(split_part({{ col }}, ':', 2) as double) / 60.0
    else try_cast({{ col }} as double)
  end
{%- endmacro %}

{#
  ESPN packs makes and attempts as "7-12".
#}
{% macro made_of(col) -%}
  try_cast(split_part({{ col }}, '-', 1) as integer)
{%- endmacro %}

{% macro attempted_of(col) -%}
  try_cast(split_part({{ col }}, '-', 2) as integer)
{%- endmacro %}


{#
  Compact dates like 20260924 (shotchartdetail GAME_DATE).
#}
{% macro yyyymmdd_to_date(col) -%}
  {{ return(adapter.dispatch('yyyymmdd_to_date', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__yyyymmdd_to_date(col) -%}
  cast(strptime({{ col }}, '%Y%m%d') as date)
{%- endmacro %}

{% macro databricks__yyyymmdd_to_date(col) -%}
  to_date({{ col }}, 'yyyyMMdd')
{%- endmacro %}
