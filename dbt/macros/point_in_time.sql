{#
  Point-in-time builds (#752). With point_in_time: true and the as_of var set, a build sees the
  world as it stood at the start of that Eastern day: every dated source is cut before it, so a
  walk-forward backtest can rebuild the lakehouse at any past date and trust that nothing after it
  leaked in. as_of alone keeps its older meaning, the run's date (a test pins "today" with it, and a
  game already final today is over by its status).

    dbt build --full-refresh --vars '{as_of: 2025-01-15, point_in_time: true}'

    - known_before(col): the row was known before as_of: a game played, a report published, a
      snapshot observed, a roster ingested. Without as_of, every row.
    - is_final(status, date): the game is over. Without as_of, the schedule's status says so
      (3 is final); with it, the game fell before as_of, whatever its status says today.

  Identity reference data (names, ids, team abbreviations, positions) is not cut. The schedule
  itself is published in advance and stays; only whether a game has been played is cut.
#}

{% macro point_in_time() -%}
  {{ return(var('point_in_time', false) and var('as_of', none) is not none) }}
{%- endmacro %}

{% macro known_before(col) -%}
  {%- if point_in_time() -%}{{ col }} < {{ as_of_date() }}{%- else -%}true{%- endif -%}
{%- endmacro %}

{#
  A source that keeps only its newest landing (Sleeper's trending list): it holds nothing about any
  earlier day, so a point-in-time build has none of it.
#}
{% macro current_only() -%}
  {%- if point_in_time() -%}false{%- else -%}true{%- endif -%}
{%- endmacro %}

{% macro is_final(status_col, date_col) -%}
  {%- if point_in_time() -%}({{ date_col }} < {{ as_of_date() }}){%- else -%}({{ status_col }} = 3){%- endif -%}
{%- endmacro %}

{#
  A backtest build writes its own tables (#752). Run once at the start of every invocation
  (on-run-start), on the global vars only, so a unit test that pins point_in_time for its own case
  never trips it: a point-in-time build needs as_of, runs on DuckDB (never over the production
  lakehouse) and from scratch (--full-refresh), so no incremental model keeps rows from after the
  date. Returns a no-op statement for the hook.
#}
{% macro guard_point_in_time() -%}
  {%- if execute and var('point_in_time', false) -%}
    {%- if var('as_of', none) is none -%}
      {{ exceptions.raise_compiler_error("point_in_time needs as_of: the date the build stands at") }}
    {%- endif -%}
    {%- if target.type != 'duckdb' -%}
      {{ exceptions.raise_compiler_error("point-in-time builds run on DuckDB only: one on " ~ target.type ~ " would overwrite the production tables") }}
    {%- endif -%}
    {%- if not flags.FULL_REFRESH -%}
      {{ exceptions.raise_compiler_error("a point-in-time build must be a --full-refresh: an incremental model would keep rows from after the date") }}
    {%- endif -%}
  {%- endif -%}
  select 1
{%- endmacro %}
