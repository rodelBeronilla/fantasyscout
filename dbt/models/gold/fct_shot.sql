{{
    config(
        materialized='incremental',
        incremental_strategy='merge',
        unique_key='shot_key',
        on_schema_change='append_new_columns',
        partition_by=(['league', 'season'] if target.type == 'databricks' else none),
        zorder=(['player_id'] if target.type == 'databricks' else none),
        pre_hook="{{ replace_changed_games([ref('shots')]) }}",
    )
}}

{#
  One row per field goal attempt with court coordinates (tenths of a foot from the basket).
  Incremental by game (dbt/macros/incremental.sql): a game's rows are replaced when its shots
  land again.
#}

select
    {{ sk(['s.league', 's.game_id', "cast(s.game_event_id as string)"]) }} as shot_sk,
    {{ sk(['s.league', 's.game_id']) }} as game_sk,
    {{ sk(['s.league', 's.season', 's.team_id']) }} as team_sk,
    s.shot_key,
    s.league,
    s.season,
    s.game_id,
    s.game_date,
    s.game_event_id,
    s.player_id,
    s.player_name,
    s.team_id,
    s.period,
    s.minutes_remaining * 60 + s.seconds_remaining as seconds_remaining,
    s.event_type,
    s.action_type,
    s.shot_type,
    s.shot_type like '3PT%' as is_three,
    s.shot_zone_basic,
    s.shot_zone_area,
    s.shot_zone_range,
    s.shot_distance,
    s.loc_x,
    s.loc_y,
    s.shot_attempted,
    s.shot_made,
    case when s.shot_made then case when s.shot_type like '3PT%' then 3 else 2 end else 0 end as points,
    s._ingest_date
from {{ ref('shots') }} as s
where {{ only_changed_games([ref('shots')]) }}
    and {{ known_before('s.game_date') }}
