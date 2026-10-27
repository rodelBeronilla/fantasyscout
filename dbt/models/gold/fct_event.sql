{{
    config(
        materialized='incremental',
        incremental_strategy='merge',
        unique_key='event_key',
        partition_by=(['league', 'season'] if target.type == 'databricks' else none),
        zorder=(['game_id'] if target.type == 'databricks' else none),
    )
}}

{#
  One row per play-by-play action. The lineup on the floor needs substitution tracking across
  periods and is added with the lineup model in a later phase; the columns are reserved here.
#}

select
    {{ sk(['e.league', 'e.game_id', "cast(e.action_number as varchar)"]) }} as event_sk,
    {{ sk(['e.league', 'e.game_id']) }} as game_sk,
    e.event_key,
    e.league,
    e.season,
    e.game_id,
    g.game_date,
    e.action_number,
    e.action_id,
    e.period,
    e.clock,
    -- "PT11M23.00S" to seconds remaining in the period
    try_cast(substr(e.clock, 3, 2) as integer) * 60 + try_cast(substr(e.clock, 6, 5) as double) as seconds_remaining,
    e.team_id,
    e.team_tricode,
    e.player_id,
    e.player_name,
    e.action_type,
    e.sub_type,
    e.description,
    e.location,
    e.is_field_goal,
    e.shot_result,
    e.shot_value,
    e.shot_distance,
    e.x_legacy,
    e.y_legacy,
    e.score_home,
    e.score_away,
    e.points_total,
    cast(null as varchar) as lineup_home,
    cast(null as varchar) as lineup_away,
    e._ingest_date
from {{ ref('events') }} as e
left join {{ ref('games') }} as g
    on g.league = e.league and g.game_id = e.game_id
{% if is_incremental() %}
where e._ingest_date >= (select coalesce(max(_ingest_date), cast('1900-01-01' as date)) from {{ this }})
{% endif %}
