{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# DraftKings' player totals from ESPN's core API, as landed (ingest/props.py): one row per player
   and market per snapshot, with the line, the over and under prices and the opening line and
   prices. The ingestor has already split ESPN's two quotes into the over and the under and left
   out milestones, quarter and game lines. Private (ADR 0008). #}

with files as (

    select *
    from ({{ landing_files('espn', 'prop_bets') }}) as landed
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
    {{ json_text('props.payload', '$.provider') }} as bookmaker,
    {{ json_text('props.payload', '$.snapshot_key') }} as snapshot_key,
    {{ json_text('props.payload', '$.fetched_at') }} as fetched_at,
    {{ json_text('props.payload', '$.commence_at') }} as commence_at,
    {{ json_text('props.payload', '$.game_date_et') }} as game_date_et,
    {{ json_text('props.payload', '$.home_team_id') }} as espn_home_team_id,
    {{ json_text('props.payload', '$.away_team_id') }} as espn_away_team_id,
    {{ json_text('props.prop', '$.athlete_id') }} as espn_player_id,
    {{ json_text('props.prop', '$.type_id') }} as prop_type_id,
    {{ json_text('props.prop', '$.prop_type') }} as prop_type,
    {{ json_text('props.prop', '$.line') }} as line,
    {{ json_text('props.prop', '$.open_line') }} as open_line,
    {{ json_text('props.prop', '$.over_odds') }} as over_odds,
    {{ json_text('props.prop', '$.under_odds') }} as under_odds,
    {{ json_text('props.prop', '$.over_open_odds') }} as over_open_odds,
    {{ json_text('props.prop', '$.under_open_odds') }} as under_open_odds,
    {{ json_text('props.prop', '$.last_updated') }} as last_updated
from props
