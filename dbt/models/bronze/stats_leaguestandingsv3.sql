{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `leaguestandingsv3` payloads parsed to rows (the columns the platform uses, by
   position in the result set); values stay text until silver. #}

with files as (

    select *
    from ({{ landing_files('stats', 'leaguestandingsv3') }}) as landed
    {{ bronze_incremental_filter() }}

),

rows as (

    select
        files.*,
        {{ json_rows('files.payload', '$.resultSets[0].rowSet') }} as row
    from files

)

select
    rows._source_file,
    rows.league,
    rows.season,
    rows._ingest_date,
    rows.request_key,
    {{ sha256('rows.payload') }} as _payload_hash,
    {{ json_text('rows.row', '$[2]') }} as team_id,
    {{ json_text('rows.row', '$[3]') }} as team_city,
    {{ json_text('rows.row', '$[4]') }} as team_name,
    {{ json_text('rows.row', '$[6]') }} as conference,
    {{ json_text('rows.row', '$[8]') }} as playoff_rank,
    {{ json_text('rows.row', '$[9]') }} as clinch_indicator,
    {{ json_text('rows.row', '$[13]') }} as wins,
    {{ json_text('rows.row', '$[14]') }} as losses,
    {{ json_text('rows.row', '$[15]') }} as win_pct,
    {{ json_text('rows.row', '$[20]') }} as last_10,
    {{ json_text('rows.row', '$[37]') }} as current_streak,
    {{ json_text('rows.row', '$[38]') }} as conference_games_back,
    {{ json_text('rows.row', '$[40]') }} as clinched_conference,
    {{ json_text('rows.row', '$[42]') }} as clinched_playoffs,
    {{ json_text('rows.row', '$[43]') }} as clinched_play_in,
    {{ json_text('rows.row', '$[44]') }} as eliminated
from rows
