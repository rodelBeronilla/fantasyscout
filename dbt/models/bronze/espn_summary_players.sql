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
        {{ json_rows('files.payload', '$.boxscore.players') }} as team_block
    from files

),

athletes as (

    select
        teams.*,
        {{ json_text('teams.team_block', '$.team.id') }} as team_id,
        {{ json_text('teams.team_block', '$.statistics[0].keys') }} as stat_keys,
        {{ json_rows('teams.team_block', '$.statistics[0].athletes') }} as entry
    from teams

)

select
    athletes._source_file,
    athletes.league,
    athletes.season,
    athletes._ingest_date,
    athletes.request_key,
    {{ sha256('athletes.payload') }} as _payload_hash,
    {{ json_text('athletes.payload', '$.header.id') }} as event_id,
    {{ json_text('athletes.payload', '$.header.competitions[0].date') }} as event_date,
    athletes.team_id,
    {{ json_text('athletes.entry', '$.athlete.id') }} as athlete_id,
    {{ json_text('athletes.entry', '$.athlete.displayName') }} as athlete_name,
    {{ json_text('athletes.entry', '$.athlete.jersey') }} as jersey,
    {{ json_text('athletes.entry', '$.athlete.position.abbreviation') }} as position,
    {{ json_text('athletes.entry', '$.starter') }} as starter,
    {{ json_text('athletes.entry', '$.didNotPlay') }} as did_not_play,
    {{ json_text('athletes.entry', '$.reason') }} as reason,
    {{ json_text('athletes.entry', '$.ejected') }} as ejected,
    athletes.stat_keys,
    {{ json_text('athletes.entry', '$.stats') }} as stats
from athletes
