{#
  The play-by-play chain is incremental by game (ADR 0004, 2026-11-01 addendum).

  Every table in the chain (silver.events, silver.shots, silver.event_lineups, gold.fct_event,
  gold.fct_shot) carries each row's _ingest_date, the newest landing the row was built from. A
  game is recomputed when any of the table's inputs landed it on or after the newest landing the
  table holds: the newest day is always redone, because several landings can share a day, and
  everything older is left alone. The day after a backfill that landed a season in one day is
  therefore a one-time rebuild of that season; a nightly run redoes the day's games.

  Recomputing means replacing. The pre-hook deletes the changed games' rows and the merge writes
  them back, so an action a re-landed feed no longer carries goes away as it would on a full
  refresh. The hook pins the watermark before it deletes (a literal, so the delete's subquery
  reads only the inputs); the model body reads the watermark after, which can only widen its set,
  and the merge makes writing a game twice harmless. The delete matches one concatenated key:
  Delta's DELETE rejects a multi-column IN (DELTA_UNSUPPORTED_MULTI_COL_IN_PREDICATE). A run that fails between the two statements
  leaves the next run a wider set, nothing else.

  A table built before the chain carried _ingest_date has no watermark to read. Both macros
  notice (has_watermark) and treat that run as a rebuild: the hook empties the table, the where
  clause selects every game, and the merge adds the column (on_schema_change: append_new_columns)
  and writes every game once. The next run is incremental again.

  has_watermark(): an incremental run on a table that carries _ingest_date.
  changed_games(sources): the games with a landing on or after this table's newest, as a query.
  only_changed_games(sources): a predicate for a model's where clause; `true` on a full build.
  replace_changed_games(sources): the pre-hook.
#}

{% macro has_watermark() -%}
    {%- if is_incremental() -%}
        {%- set names = adapter.get_columns_in_relation(this) | map(attribute='name') | map('lower') | list -%}
        {{- return('_ingest_date' in names) -}}
    {%- endif -%}
    {{- return(false) -}}
{%- endmacro %}

{% macro landed_games(sources) -%}
    (
        {%- for source in sources %}
        select league, game_id, _ingest_date from {{ source }}
        {%- if not loop.last %}
        union all
        {%- endif -%}
        {%- endfor %}
    ) as landed
{%- endmacro %}

{% macro changed_games(sources) -%}
    select distinct league, game_id
    from {{ landed_games(sources) }}
    where _ingest_date >= (select coalesce(max(_ingest_date), cast('1900-01-01' as date)) from {{ this }})
{%- endmacro %}

{% macro only_changed_games(sources) -%}
    {%- if has_watermark() -%}
    (league, game_id) in (select league, game_id from ({{ changed_games(sources) }}) as changed)
    {%- else -%}
    true
    {%- endif -%}
{%- endmacro %}

{% macro replace_changed_games(sources) -%}
    {%- if is_incremental() and not has_watermark() -%}
    -- the table predates the watermark column: one rebuild, every game written once by the merge
    delete from {{ this }} where true
    {%- elif is_incremental() -%}
    {%- set rows = run_query("select cast(coalesce(max(_ingest_date), cast('1900-01-01' as date)) as string) from " ~ this) -%}
    {%- set newest = rows.columns[0].values()[0] -%}
    {#- one key, not (league, game_id): Delta's DELETE does not take a multi-column IN -#}
    delete from {{ this }}
    where concat_ws(':', league, game_id) in (
        select concat_ws(':', league, game_id)
        from {{ landed_games(sources) }}
        where _ingest_date >= cast('{{ newest }}' as date)
    )
    {%- else -%}
    -- a first build or a full refresh replaces the whole table; the hook still has to be a statement
    select 1 as nothing_to_replace
    {%- endif -%}
{%- endmacro %}
