{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The tables the owner saved while browsing with the Save tables bookmarklet (#792), as landed by
   `fs-ingest import`: one row per saved table row, with the site it came from, the page's
   address, the table's heading and header row, and the row's cells as JSON (each cell's text and
   link). Source-specific models read it once a source's pages show their shape. #}

with files as (

    select *
    from ({{ landing_files('manual', 'saved_tables') }}) as landed
    {{ bronze_incremental_filter() }}

),

saved_tables as (

    select
        files.*,
        {{ json_text('files.payload', '$.source') }} as saved_from,
        {{ json_text('files.payload', '$.url') }} as page_url,
        {{ json_text('files.payload', '$.saved_at') }} as saved_at,
        {{ json_rows('files.payload', '$.tables') }} as saved_table
    from files

),

saved_rows as (

    select
        saved_tables.*,
        {{ json_text('saved_tables.saved_table', '$.label') }} as table_label,
        {{ json_text('saved_tables.saved_table', '$.headers') }} as headers,
        {{ json_rows('saved_tables.saved_table', '$.rows') }} as cells
    from saved_tables

)

select
    saved_rows._source_file,
    saved_rows.league,
    saved_rows.season,
    saved_rows._ingest_date,
    saved_rows.request_key,
    saved_rows.saved_from,
    saved_rows.page_url,
    saved_rows.saved_at,
    saved_rows.table_label,
    saved_rows.headers,
    cast(saved_rows.cells as {{ dbt.type_string() }}) as cells
from saved_rows
