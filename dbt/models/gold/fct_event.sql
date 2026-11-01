{{
    config(
        materialized='incremental',
        incremental_strategy='merge',
        unique_key='event_key',
        on_schema_change='append_new_columns',
        partition_by=(['league', 'season'] if target.type == 'databricks' else none),
        zorder=(['game_id'] if target.type == 'databricks' else none),
    )
}}

{#
  One row per play-by-play action, with the five players on the floor for each side
  (silver.event_lineups: comma-separated league player ids, sorted; lineup_complete when both
  sides have five).

  Incremental by game, not by the event's landing date: the row also carries the game date from
  games and the lineups from event_lineups, which come from the box score, and a box score may
  land a day after the play-by-play (the completeness check tolerates exactly that). A game is
  re-merged whenever any of its inputs landed on or after the newest landing already in the
  table, so a late box score fills in the lineups without a full refresh.
#}

{% if is_incremental() %}
with changed as (

    select distinct league, game_id
    from (
        select league, game_id, _ingest_date from {{ ref('events') }}
        union all
        select league, game_id, _ingest_date from {{ ref('player_game_box') }}
        union all
        select league, game_id, _ingest_date from {{ ref('games') }}
    ) as landed
    where _ingest_date >= (select coalesce(max(_ingest_date), cast('1900-01-01' as date)) from {{ this }})

)

{% endif %}
select
    {{ sk(['e.league', 'e.game_id', "cast(e.action_number as string)"]) }} as event_sk,
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
    l.lineup_home,
    l.lineup_away,
    coalesce(l.lineup_complete, false) as lineup_complete,
    e._ingest_date
from {{ ref('events') }} as e
left join {{ ref('games') }} as g
    on g.league = e.league and g.game_id = e.game_id
left join {{ ref('event_lineups') }} as l
    on l.event_key = e.event_key
{% if is_incremental() %}
inner join changed as c
    on c.league = e.league and c.game_id = e.game_id
{% endif %}
