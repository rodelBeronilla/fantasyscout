{#
  Reading the league stats API's resultSets by header name.

  A stats payload carries `headers` (column names) and `rowSet` (rows of values in the same
  order). Reading a row by position breaks silently when the API inserts a column: every later
  value shifts into the wrong column, as text, and only an arithmetic check downstream would
  notice. These macros resolve the position from the payload's own headers at query time, so an
  inserted column changes nothing and a renamed or removed one yields null (which the silver
  not_null tests then catch by name).
#}

{# The headers of one result set, as an array of strings. #}
{% macro stats_headers(payload_col, set_index=0) -%}
  {{ return(adapter.dispatch('stats_headers', 'fantasyscout')(payload_col, set_index)) }}
{%- endmacro %}

{% macro default__stats_headers(payload_col, set_index=0) -%}
  cast(json_extract({{ payload_col }}, '$.resultSets[{{ set_index }}].headers') as varchar[])
{%- endmacro %}

{% macro databricks__stats_headers(payload_col, set_index=0) -%}
  from_json(get_json_object({{ payload_col }}, '$.resultSets[{{ set_index }}].headers'), 'array<string>')
{%- endmacro %}


{# One row of a result set (as json_rows yields it), as an array of strings. #}
{% macro stats_row_values(row_col) -%}
  {{ return(adapter.dispatch('stats_row_values', 'fantasyscout')(row_col)) }}
{%- endmacro %}

{% macro default__stats_row_values(row_col) -%}
  json_extract_string({{ row_col }}, '$[*]')
{%- endmacro %}

{% macro databricks__stats_row_values(row_col) -%}
  from_json(cast({{ row_col }} as string), 'array<string>')
{%- endmacro %}


{# The value under a header name, or null when the payload has no such header. #}
{% macro stats_cell(values_col, headers_col, name) -%}
  {{ return(adapter.dispatch('stats_cell', 'fantasyscout')(values_col, headers_col, name)) }}
{%- endmacro %}

{% macro default__stats_cell(values_col, headers_col, name) -%}
  {{ values_col }}[array_position({{ headers_col }}, '{{ name }}')]
{%- endmacro %}

{% macro databricks__stats_cell(values_col, headers_col, name) -%}
  case when array_position({{ headers_col }}, '{{ name }}') > 0
    then element_at({{ values_col }}, cast(array_position({{ headers_col }}, '{{ name }}') as int)) end
{%- endmacro %}
