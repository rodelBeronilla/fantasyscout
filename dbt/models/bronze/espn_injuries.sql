{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw espn `injuries` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('espn', 'injuries') }}) as landed
    {{ bronze_incremental_filter() }}

),

teams as (

    select
        files.*,
        {{ json_rows('files.payload', '$.injuries') }} as team_block
    from files

),

injuries as (

    select
        teams.*,
        {{ json_text('teams.team_block', '$.id') }} as team_id,
        {{ json_text('teams.team_block', '$.displayName') }} as team_name,
        {{ json_rows('teams.team_block', '$.injuries') }} as injury
    from teams

)

select
    injuries._source_file,
    injuries.league,
    injuries.season,
    injuries._ingest_date,
    injuries.request_key,
    {{ sha256('injuries.payload') }} as _payload_hash,
    {{ json_text('injuries.payload', '$.timestamp') }} as report_timestamp,
    injuries.team_id,
    injuries.team_name,
    {{ json_text('injuries.injury', '$.id') }} as injury_id,
    {{ json_text('injuries.injury', '$.athlete.id') }} as athlete_id,
    {{ json_text('injuries.injury', '$.athlete.displayName') }} as athlete_name,
    {{ json_text('injuries.injury', '$.status') }} as status,
    {{ json_text('injuries.injury', '$.date') }} as reported_at,
    {{ json_text('injuries.injury', '$.details.type') }} as injury_type,
    {{ json_text('injuries.injury', '$.details.returnDate') }} as return_date,
    {{ json_text('injuries.injury', '$.details.fantasyStatus.description') }} as fantasy_status,
    {{ json_text('injuries.injury', '$.shortComment') }} as short_comment,
    {{ json_text('injuries.injury', '$.longComment') }} as long_comment
from injuries
