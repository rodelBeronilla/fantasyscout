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

{#
  The morning cut (#1140, ADR 0018's addendum). Two feeds are read as of the build day's morning
  instead of its start: ESPN's injury listing and the leagues' official injury reports. A build as
  of D then holds what a manager saw on D's morning, the listing the morning ingest landed on D,
  and none of D's games, which every other feed still cuts by date.

    - morning_cut(): the instant, MORNING_CUT_UTC on the as_of date, in UTC: one time for every
      season and both leagues. The morning ingest starts at 09:30 UTC; the cut leaves it two and a
      half hours, and comes before any game of either league tips off (the earliest, the
      WNBA's late-morning games, start at 11:30 Eastern, 15:30 UTC at the earliest).
    - known_by_morning(instant): a typed UTC instant (an official report's publication) before
      the cut.
    - landed_by_morning(ingest_date, fetched): a landed file of an earlier day, or of the day itself
      fetched before the cut. ``fetched`` is the fetch time the landed file records (ESPN's own
      timestamp of the answer), so a morning ingest that ran late is read only if it ran before
      the cut; otherwise the build reads the day before's listing.
#}
{% macro morning_cut() -%}
  {%- set MORNING_CUT_UTC = '12:00:00' -%}
  cast('{{ var('as_of') }} {{ MORNING_CUT_UTC }}+00:00' as timestamptz)
{%- endmacro %}

{% macro known_by_morning(instant) -%}
  {%- if point_in_time() -%}{{ instant }} < {{ morning_cut() }}{%- else -%}true{%- endif -%}
{%- endmacro %}

{% macro landed_by_morning(ingest_date, fetched) -%}
  {%- if point_in_time() -%}
  ({{ ingest_date }} < {{ as_of_date() }} or ({{ ingest_date }} = {{ as_of_date() }} and {{ fetched }} < {{ morning_cut() }}))
  {%- else -%}true{%- endif -%}
{%- endmacro %}
