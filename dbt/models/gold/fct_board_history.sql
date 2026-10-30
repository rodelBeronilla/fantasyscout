{{
    config(
        materialized='incremental',
        incremental_strategy='merge',
        unique_key='board_history_sk',
        on_schema_change='append_new_columns',
        full_refresh=false,
        partition_by=(['league'] if target.type == 'databricks' else none),
    )
}}

{#
  A daily ledger of the board: what the board said about each player on each Eastern date, kept
  after the builds that published it roll off. Every build merges today's rows (a later build the
  same day replaces them), and a full refresh never rebuilds it (full_refresh=false), so the
  history only grows. It holds the projection and value, and the context the board shows beside
  the value (availability with the official status and reason, lineups, the ESPN market with its
  raw shares, stakes, waiver heat, last-ten production, the newest headline flag), so the
  signals that have only days of history so far can be backtested once they have a season.
#}

with streamers as (

    select league, player_id, minutes_trend, value_trend, sleeper_adds, sleeper_drops, last_10_production
    from {{ ref('mart_streamers') }}

),

status as (

    select league, stats_player_id, official_status, official_reason_group
    from {{ ref('fct_player_status') }}

)

select
    {{ sk(["cast(" ~ eastern_today() ~ " as string)", 'b.league', 'b.player_id']) }} as board_history_sk,
    {{ eastern_today() }} as snapshot_date,
    {{ now_ts() }} as snapshot_at,
    b.league,
    b.season,
    b.player_id,
    b.team_id,
    b.rank_total,
    b.value_per_game,
    b.value_total,
    b.value_rest_of_season,
    b.games_share,
    b.availability_multiplier,
    b.games_remaining,
    b.games_next_7,
    b.proj_minutes_pg,
    b.proj_points_pg,
    b.proj_rebounds_total_pg,
    b.proj_assists_pg,
    b.proj_steals_pg,
    b.proj_blocks_pg,
    b.proj_three_pointers_made_pg,
    b.proj_turnovers_pg,
    b.proj_field_goal_pct,
    b.proj_free_throw_pct,
    b.injury_status,
    b.injury_group,
    b.injury_source,
    b.lineup_role,
    b.lineup_confirmed,
    b.market_rank,
    b.ownership_bucket,
    b.team_stakes,
    b.rest_risk,
    b.news_flag,
    s.minutes_trend,
    s.value_trend,
    s.sleeper_adds,
    s.sleeper_drops,
    s.last_10_production,
    b.expected_games_missed,
    st.official_status,
    st.official_reason_group,
    b.ownership_trend,
    mk.percent_owned,
    mk.percent_started,
    mk.percent_owned_change,
    mk.average_draft_position,
    mk.auction_value_average
from {{ ref('mart_board') }} as b
left join streamers as s on s.league = b.league and s.player_id = b.player_id
left join status as st on st.league = b.league and st.stats_player_id = b.player_id
left join {{ ref('fct_market_value') }} as mk on mk.league = b.league and mk.stats_player_id = b.player_id
