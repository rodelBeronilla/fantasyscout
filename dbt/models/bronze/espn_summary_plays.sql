{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw espn `summary` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('espn', 'summary') }}) as landed
    {{ bronze_incremental_filter() }}

),

plays as (

    select
        files.*,
        {{ json_rows('files.payload', '$.plays') }} as play
    from files

)

select
    plays._source_file,
    plays.league,
    plays.season,
    plays._ingest_date,
    plays.request_key,
    {{ sha256('plays.payload') }} as _payload_hash,
    {{ json_text('plays.payload', '$.header.id') }} as event_id,
    {{ json_text('plays.play', '$.id') }} as play_id,
    {{ json_text('plays.play', '$.sequenceNumber') }} as sequence_number,
    {{ json_text('plays.play', '$.type.id') }} as type_id,
    {{ json_text('plays.play', '$.type.text') }} as type_text,
    {{ json_text('plays.play', '$.text') }} as text,
    {{ json_text('plays.play', '$.period.number') }} as period,
    {{ json_text('plays.play', '$.clock.displayValue') }} as clock,
    {{ json_text('plays.play', '$.homeScore') }} as home_score,
    {{ json_text('plays.play', '$.awayScore') }} as away_score,
    {{ json_text('plays.play', '$.scoringPlay') }} as scoring_play,
    {{ json_text('plays.play', '$.scoreValue') }} as score_value,
    {{ json_text('plays.play', '$.shootingPlay') }} as shooting_play,
    {{ json_text('plays.play', '$.pointsAttempted') }} as points_attempted,
    {{ json_text('plays.play', '$.team.id') }} as team_id,
    {{ json_text('plays.play', '$.participants') }} as participants,
    {{ json_text('plays.play', '$.coordinate.x') }} as coordinate_x,
    {{ json_text('plays.play', '$.coordinate.y') }} as coordinate_y,
    {{ json_text('plays.play', '$.wallclock') }} as wallclock
from plays
