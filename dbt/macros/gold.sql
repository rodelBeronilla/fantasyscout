{#
  Helpers for the gold layer that read the same on DuckDB and Databricks.
#}

{# Deterministic surrogate key from one or more columns. NULL parts are skipped by concat_ws. #}
{% macro sk(cols) -%}
  md5(concat_ws(':', {{ cols | join(', ') }}))
{%- endmacro %}


{% macro date_spine(start_date, end_date) -%}
  {{ return(adapter.dispatch('date_spine', 'fantasyscout')(start_date, end_date)) }}
{%- endmacro %}

{% macro default__date_spine(start_date, end_date) -%}
  select cast(d as date) as date_day
  from generate_series(cast('{{ start_date }}' as date), cast('{{ end_date }}' as date), interval 1 day) as t(d)
{%- endmacro %}

{% macro databricks__date_spine(start_date, end_date) -%}
  select explode(sequence(to_date('{{ start_date }}'), to_date('{{ end_date }}'), interval 1 day)) as date_day
{%- endmacro %}


{# ISO day of week, 1 = Monday .. 7 = Sunday. #}
{% macro iso_dow(col) -%}
  {{ return(adapter.dispatch('iso_dow', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__iso_dow(col) -%}
  isodow({{ col }})
{%- endmacro %}

{% macro databricks__iso_dow(col) -%}
  ((dayofweek({{ col }}) + 5) % 7) + 1
{%- endmacro %}


{% macro add_days(col, n) -%}
  {{ return(adapter.dispatch('add_days', 'fantasyscout')(col, n)) }}
{%- endmacro %}

{% macro default__add_days(col, n) -%}
  ({{ col }} + ({{ n }}))
{%- endmacro %}

{% macro databricks__add_days(col, n) -%}
  date_add({{ col }}, {{ n }})
{%- endmacro %}


{# Whole days from a to b (positive when b is later). #}
{% macro days_between(a, b) -%}
  {{ return(adapter.dispatch('days_between', 'fantasyscout')(a, b)) }}
{%- endmacro %}

{% macro default__days_between(a, b) -%}
  datediff('day', {{ a }}, {{ b }})
{%- endmacro %}

{% macro databricks__days_between(a, b) -%}
  datediff({{ b }}, {{ a }})
{%- endmacro %}


{# Monday of the week containing the date. #}
{% macro week_start(col) -%}
  cast(date_trunc('week', {{ col }}) as date)
{%- endmacro %}


{# Number of elements in the JSON array at path (0 when missing). #}
{% macro json_array_len(col, path) -%}
  {{ return(adapter.dispatch('json_array_len', 'fantasyscout')(col, path)) }}
{%- endmacro %}

{% macro default__json_array_len(col, path) -%}
  coalesce(json_array_length({{ col }}, '{{ path }}'), 0)
{%- endmacro %}

{% macro databricks__json_array_len(col, path) -%}
  coalesce(size(from_json(get_json_object({{ col }}, '{{ path }}'), 'array<string>')), 0)
{%- endmacro %}


{# Any JSON files under a glob, as (_source_file, payload); for the ops run logs. #}
{% macro raw_json_files(glob) -%}
  {{ return(adapter.dispatch('raw_json_files', 'fantasyscout')(glob)) }}
{%- endmacro %}

{% macro default__raw_json_files(glob) -%}
  select filename as _source_file, content as payload
  from read_text('{{ landing_root() }}/{{ glob }}')
{%- endmacro %}

{% macro databricks__raw_json_files(glob) -%}
  select _metadata.file_path as _source_file, value as payload
  from read_files('{{ landing_root() }}/{{ glob }}', format => 'text', wholetext => true)
{%- endmacro %}


{# Current timestamp as a timestamp (both engines). #}
{% macro now_ts() -%}
  current_timestamp
{%- endmacro %}

{# Run date: today unless the build pins one (tests use var('as_of') for determinism). #}
{#
  Today in US Eastern time, the calendar the leagues schedule by: a game tonight is still today
  for a build that runs after 8 pm Eastern, when the UTC date has already turned. The as_of var
  overrides it, as it does as_of_date().
#}
{% macro eastern_today() -%}
  {%- if var('as_of', none) -%}cast('{{ var('as_of') }}' as date){%- else -%}{{ return(adapter.dispatch('eastern_today', 'fantasyscout')()) }}{%- endif -%}
{%- endmacro %}

{% macro default__eastern_today() -%}
  cast(timezone('America/New_York', now()) as date)
{%- endmacro %}

{% macro databricks__eastern_today() -%}
  cast(from_utc_timestamp(current_timestamp(), 'America/New_York') as date)
{%- endmacro %}

{% macro as_of_date() -%}
  {%- if var('as_of', none) -%}cast('{{ var('as_of') }}' as date){%- else -%}current_date{%- endif -%}
{%- endmacro %}
