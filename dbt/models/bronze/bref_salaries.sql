{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Basketball-Reference team payrolls as landed (#772): one row per player per team-season page,
   the player's Basketball-Reference id, name and salary. Values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('bref', 'salaries') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ json_text('files.payload', '$.team') }} as bref_team,
        {{ json_rows('files.payload', '$.rows') }} as player
    from files

)

select
    rows._source_file,
    rows.league,
    rows.season,
    rows._ingest_date,
    rows.request_key,
    rows.bref_team,
    {{ json_text('rows.player', '$.bref_player_id') }} as bref_player_id,
    {{ json_text('rows.player', '$.name') }} as player_name,
    {{ json_text('rows.player', '$.salary') }} as salary
from rows
