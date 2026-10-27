{#
  Reading landed JSON on both engines.

  Every landed payload lives at
    <root>/landing/<source>/<endpoint>/<league>/<season>/<ingest_date>/<key>.json
  with a <key>.meta.json sidecar next to it. landing_files() returns one row per payload with
  the path-derived columns every bronze model needs. DuckDB reads the local directory,
  Databricks reads the Unity Catalog volume; the SQL on top is identical.
#}

{% macro landing_root() -%}
  {%- if target.type == 'databricks' -%}
    /Volumes/fantasyscout/raw
  {%- else -%}
    {{ var('landing_root') }}
  {%- endif -%}
{%- endmacro %}

{% macro landing_glob(source, endpoint) -%}
  {{ landing_root() }}/landing/{{ source }}/{{ endpoint }}/*/*/*/*.json
{%- endmacro %}

{% macro path_part(col, n_from_end) -%}
  {{ return(adapter.dispatch('path_part', 'fantasyscout')(col, n_from_end)) }}
{%- endmacro %}

{% macro default__path_part(col, n_from_end) -%}
  string_split({{ col }}, '/')[-{{ n_from_end }}]
{%- endmacro %}

{% macro databricks__path_part(col, n_from_end) -%}
  element_at(split({{ col }}, '/'), -{{ n_from_end }})
{%- endmacro %}

{% macro landing_files(source, endpoint) -%}
  {{ return(adapter.dispatch('landing_files', 'fantasyscout')(source, endpoint)) }}
{%- endmacro %}

{% macro default__landing_files(source, endpoint) -%}
  select
    filename as _source_file,
    content as payload,
    {{ path_part('filename', 4) }} as league,
    {{ path_part('filename', 3) }} as season,
    cast({{ path_part('filename', 2) }} as date) as _ingest_date,
    regexp_replace({{ path_part('filename', 1) }}, '\.json$', '') as request_key
  from read_text('{{ landing_glob(source, endpoint) }}')
  where filename not like '%.meta.json'
{%- endmacro %}

{#
  On Databricks an incremental run prunes the file listing itself: read_files only opens
  files modified since the day before the table's newest ingest date, so a nightly build over
  years of landed history reads one day of files, not all of them.
#}
{% macro bronze_modified_after() -%}
  {%- if is_incremental() and execute -%}
    {%- set rows = run_query("select cast(coalesce(max(_ingest_date), cast('1900-01-01' as date)) as string) from " ~ this) -%}
    {%- set watermark = rows.columns[0].values()[0] -%}
    {{ return(watermark ~ "T00:00:00Z") }}
  {%- else -%}
    {{ return(none) }}
  {%- endif -%}
{%- endmacro %}

{% macro databricks__landing_files(source, endpoint) -%}
  {%- set modified_after = bronze_modified_after() -%}
  select
    _metadata.file_path as _source_file,
    value as payload,
    {{ path_part('_metadata.file_path', 4) }} as league,
    {{ path_part('_metadata.file_path', 3) }} as season,
    cast({{ path_part('_metadata.file_path', 2) }} as date) as _ingest_date,
    regexp_replace({{ path_part('_metadata.file_path', 1) }}, '\\.json$', '') as request_key
  from read_files(
    '{{ landing_glob(source, endpoint) }}',
    format => 'text',
    wholetext => true
    {%- if modified_after %},
    modifiedAfter => '{{ modified_after }}'
    {%- endif %}
  )
  where _metadata.file_path not like '%.meta.json'
{%- endmacro %}

{#
  Bronze models are append-only and incremental: only ingest dates newer than what the table
  already holds are read in.
#}
{% macro bronze_incremental_filter(date_col='_ingest_date') -%}
  {% if is_incremental() -%}
    where {{ date_col }} > (select coalesce(max(_ingest_date), cast('1900-01-01' as date)) from {{ this }})
  {%- endif %}
{%- endmacro %}
