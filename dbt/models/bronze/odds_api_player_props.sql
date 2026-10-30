{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# The Odds API's player props, as landed (ingest/props.py): one row per bookmaker, market, player
   and line per snapshot, with the over and under prices. The ingestor has already paired each
   over with its under. Private (ADR 0008). #}

with files as (

    select *
    from ({{ landing_files('odds_api', 'player_props') }}) as landed
    {{ bronze_incremental_filter() }}

),

props as (

    select
        files.*,
        {{ json_rows('files.payload', '$.props') }} as prop
    from files

)

select
    props._source_file,
    props.league,
    props.season,
    props._ingest_date,
    props.request_key,
    {{ json_text('props.payload', '$.event_id') }} as event_id,
    {{ json_text('props.payload', '$.sport_key') }} as sport_key,
    {{ json_text('props.payload', '$.snapshot_key') }} as snapshot_key,
    {{ json_text('props.payload', '$.fetched_at') }} as fetched_at,
    {{ json_text('props.payload', '$.commence_at') }} as commence_at,
    {{ json_text('props.payload', '$.game_date_et') }} as game_date_et,
    {{ json_text('props.payload', '$.home_team') }} as home_team_name,
    {{ json_text('props.payload', '$.away_team') }} as away_team_name,
    {{ json_text('props.prop', '$.bookmaker') }} as bookmaker,
    {{ json_text('props.prop', '$.market') }} as market_key,
    {{ json_text('props.prop', '$.player_name') }} as player_name,
    {{ json_text('props.prop', '$.line') }} as line,
    {{ json_text('props.prop', '$.over_odds') }} as over_odds,
    {{ json_text('props.prop', '$.under_odds') }} as under_odds,
    {{ json_text('props.prop', '$.last_updated') }} as last_updated
from props
