{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw espn `summary` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('espn', 'summary') }}) as landed
    {{ bronze_incremental_filter() }}

),

teams as (

    select
        files.*,
        {{ json_rows('files.payload', '$.boxscore.teams') }} as team_block
    from files

)

select
    teams._source_file,
    teams.league,
    teams.season,
    teams._ingest_date,
    teams.request_key,
    {{ sha256('teams.payload') }} as _payload_hash,
    {{ json_text('teams.payload', '$.header.id') }} as event_id,
    {{ json_text('teams.team_block', '$.team.id') }} as team_id,
    {{ json_text('teams.team_block', '$.team.abbreviation') }} as team_abbreviation,
    {{ json_text('teams.team_block', '$.homeAway') }} as home_away,
    {{ json_text('teams.team_block', '$.statistics') }} as statistics
from teams
