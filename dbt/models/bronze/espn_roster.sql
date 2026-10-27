{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw espn `roster` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('espn', 'roster') }}) as landed
    {{ bronze_incremental_filter() }}

),

athletes as (

    select
        files.*,
        {{ json_rows('files.payload', '$.athletes') }} as athlete
    from files

)

select
    athletes._source_file,
    athletes.league,
    athletes.season,
    athletes._ingest_date,
    athletes.request_key,
    {{ sha256('athletes.payload') }} as _payload_hash,
    {{ json_text('athletes.payload', '$.team.id') }} as team_id,
    {{ json_text('athletes.payload', '$.season.year') }} as season_year,
    {{ json_text('athletes.athlete', '$.id') }} as athlete_id,
    {{ json_text('athletes.athlete', '$.fullName') }} as full_name,
    {{ json_text('athletes.athlete', '$.firstName') }} as first_name,
    {{ json_text('athletes.athlete', '$.lastName') }} as last_name,
    {{ json_text('athletes.athlete', '$.jersey') }} as jersey,
    {{ json_text('athletes.athlete', '$.position.abbreviation') }} as position,
    {{ json_text('athletes.athlete', '$.height') }} as height_inches,
    {{ json_text('athletes.athlete', '$.weight') }} as weight_lbs,
    {{ json_text('athletes.athlete', '$.dateOfBirth') }} as date_of_birth,
    {{ json_text('athletes.athlete', '$.age') }} as age
from athletes
