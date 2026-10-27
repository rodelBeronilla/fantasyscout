{#
  Reconciliation helpers (phase 4): name normalisation, name similarity, null-safe equality,
  and the date arithmetic that lines ESPN's UTC event times up with the league's Eastern game
  dates. Each one is dispatched so the same models run on DuckDB and Databricks.
#}

{#
  A name reduced to lowercase ASCII letters: accents folded, generational suffixes dropped,
  everything that is not a letter removed. "A'ja Wilson" and "Aja Wilson" agree; so do
  "Luka Doncic" and "Luka Dončić", and "Gary Payton II" and "Gary Payton".
#}
{% macro norm_name(col) -%}
  {{ return(adapter.dispatch('norm_name', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__norm_name(col) -%}
  regexp_replace(
    translate(
      regexp_replace(regexp_replace(lower({{ col }}), '[(][^)]*[)]', ''), '[ ]+(jr|sr|ii|iii|iv)[.]?$', ''),
      'áàâäãåéèêëíìîïóòôöõúùûüñçýÿ', 'aaaaaaeeeeiiiiooooouuuuncyy'
    ),
    '[^a-z]', '', 'g'
  )
{%- endmacro %}

{% macro databricks__norm_name(col) -%}
  regexp_replace(
    translate(
      regexp_replace(regexp_replace(lower({{ col }}), '[(][^)]*[)]', ''), '[ ]+(jr|sr|ii|iii|iv)[.]?$', ''),
      'áàâäãåéèêëíìîïóòôöõúùûüñçýÿ', 'aaaaaaeeeeiiiiooooouuuuncyy'
    ),
    '[^a-z]', ''
  )
{%- endmacro %}

{#
  The nickname a league roster writes in parentheses: "Asia (AD) Durr" gives "AD". Null when
  there is none.
#}
{% macro nickname_in_parentheses(col) -%}
  nullif(regexp_extract({{ col }}, '[(]([^)]+)[)]', 1), '')
{%- endmacro %}

{#
  The first and last whitespace-separated tokens of a name, so "Cyesha Damian Goree" can meet
  "Cyesha Goree".
#}
{% macro first_last_tokens(col) -%}
  {{ return(adapter.dispatch('first_last_tokens', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__first_last_tokens(col) -%}
  (string_split({{ col }}, ' ')[1] || ' ' || string_split({{ col }}, ' ')[-1])
{%- endmacro %}

{% macro databricks__first_last_tokens(col) -%}
  (element_at(split({{ col }}, ' '), 1) || ' ' || element_at(split({{ col }}, ' '), -1))
{%- endmacro %}

{#
  Name similarity in [0, 1]. DuckDB has Jaro-Winkler, the function the spec names; Databricks
  SQL has no Jaro-Winkler, so there the normalised Levenshtein ratio stands in and the
  thresholds below are set per engine (ADR 0005).
#}
{% macro name_similarity(a, b) -%}
  {{ return(adapter.dispatch('name_similarity', 'fantasyscout')(a, b)) }}
{%- endmacro %}

{% macro default__name_similarity(a, b) -%}
  jaro_winkler_similarity({{ a }}, {{ b }})
{%- endmacro %}

{% macro databricks__name_similarity(a, b) -%}
  (1.0 - levenshtein({{ a }}, {{ b }}) / greatest(length({{ a }}), length({{ b }}), 1))
{%- endmacro %}

{% macro name_similarity_threshold() -%}
  {{ return(adapter.dispatch('name_similarity_threshold', 'fantasyscout')()) }}
{%- endmacro %}

{% macro default__name_similarity_threshold() -%}
  0.92
{%- endmacro %}

{% macro databricks__name_similarity_threshold() -%}
  0.75
{%- endmacro %}

{# A confirmed birthdate lets a weaker name match through. #}
{% macro name_similarity_threshold_with_birthdate() -%}
  {{ return(adapter.dispatch('name_similarity_threshold_with_birthdate', 'fantasyscout')()) }}
{%- endmacro %}

{% macro default__name_similarity_threshold_with_birthdate() -%}
  0.85
{%- endmacro %}

{% macro databricks__name_similarity_threshold_with_birthdate() -%}
  0.65
{%- endmacro %}

{# Null-safe equality: two nulls agree, a null and a value do not. #}
{% macro same_value(a, b) -%}
  {{ return(adapter.dispatch('same_value', 'fantasyscout')(a, b)) }}
{%- endmacro %}

{% macro default__same_value(a, b) -%}
  ({{ a }} is not distinct from {{ b }})
{%- endmacro %}

{% macro databricks__same_value(a, b) -%}
  ({{ a }} <=> {{ b }})
{%- endmacro %}

{#
  ESPN writes event times as "2026-09-24T23:00Z" (minute precision). Games are dated in
  Eastern time by the league, so a 10 pm tip-off is the next calendar day in UTC.
#}
{% macro espn_ts(col) -%}
  {{ return(adapter.dispatch('espn_ts', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__espn_ts(col) -%}
  cast(case when length({{ col }}) = 17 then substr({{ col }}, 1, 16) || ':00+00:00' else {{ col }} end as timestamptz)
{%- endmacro %}

{% macro databricks__espn_ts(col) -%}
  cast(case when length({{ col }}) = 17 then substr({{ col }}, 1, 16) || ':00+00:00' else {{ col }} end as timestamp)
{%- endmacro %}

{% macro utc_to_eastern_date(col) -%}
  {{ return(adapter.dispatch('utc_to_eastern_date', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__utc_to_eastern_date(col) -%}
  cast(timezone('America/New_York', {{ espn_ts(col) }}) as date)
{%- endmacro %}

{% macro databricks__utc_to_eastern_date(col) -%}
  cast(from_utc_timestamp({{ espn_ts(col) }}, 'America/New_York') as date)
{%- endmacro %}

{# The league roster writes birthdates as "JUN 10, 1996"; ESPN as "1996-06-10T07:00Z". #}
{% macro stats_birth_date(col) -%}
  {{ return(adapter.dispatch('stats_birth_date', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__stats_birth_date(col) -%}
  cast(try_strptime({{ col }}, '%b %d, %Y') as date)
{%- endmacro %}

{% macro databricks__stats_birth_date(col) -%}
  try_to_date(concat(substr({{ col }}, 1, 1), lower(substr({{ col }}, 2))), 'MMM d, yyyy')
{%- endmacro %}

{% macro espn_birth_date(col) -%}
  try_cast(substr({{ col }}, 1, 10) as date)
{%- endmacro %}
