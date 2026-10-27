{{
    config(
        materialized='incremental',
        incremental_strategy='merge',
        unique_key='shot_key',
        partition_by=(['league', 'season'] if target.type == 'databricks' else none),
        zorder=(['player_id'] if target.type == 'databricks' else none),
    )
}}

{# One row per field goal attempt with court coordinates (tenths of a foot from the basket). #}

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
{% if is_incremental() %}
where s._ingest_date >= (select coalesce(max(_ingest_date), cast('1900-01-01' as date)) from {{ this }})
{% endif %}
