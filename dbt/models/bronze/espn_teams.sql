{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw espn `teams` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('espn', 'teams') }}) as landed
    {{ bronze_incremental_filter() }}

),

teams as (

    select
        files.*,
        {{ json_rows('files.payload', '$.sports[0].leagues[0].teams') }} as entry
    from files

)

select
    teams._source_file,
    teams.league,
    teams.season,
    teams._ingest_date,
    teams.request_key,
    {{ sha256('teams.payload') }} as _payload_hash,
    {{ json_text('teams.entry', '$.team.id') }} as team_id,
    {{ json_text('teams.entry', '$.team.abbreviation') }} as abbreviation,
    {{ json_text('teams.entry', '$.team.displayName') }} as display_name,
    {{ json_text('teams.entry', '$.team.location') }} as location,
    {{ json_text('teams.entry', '$.team.name') }} as name,
    {{ json_text('teams.entry', '$.team.slug') }} as slug,
    {{ json_text('teams.entry', '$.team.isActive') }} as is_active
from teams
