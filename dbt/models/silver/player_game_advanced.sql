{#
  One row per player per game with the advanced line. Two sources carry the same measures:
  the season-level player game log (one request per season, the current source) and the
  per-game v3 advanced box score (landed for the first backfilled seasons). Latest landing wins.
#}

with from_gamelog as (

    select
        league,
        season,
        game_id,
        player_id,
        team_id,
        case when matchup like '%vs.%' then 'home' when matchup like '%@%' then 'away' end as side,
        try_cast(min as double) as minutes,
        try_cast(e_off_rating as double) as estimated_offensive_rating,
        try_cast(off_rating as double) as offensive_rating,
        try_cast(e_def_rating as double) as estimated_defensive_rating,
        try_cast(def_rating as double) as defensive_rating,
        try_cast(e_net_rating as double) as estimated_net_rating,
        try_cast(net_rating as double) as net_rating,
        try_cast(ast_pct as double) as assist_percentage,
        try_cast(ast_to as double) as assist_to_turnover,
        try_cast(ast_ratio as double) as assist_ratio,
        try_cast(oreb_pct as double) as offensive_rebound_percentage,
        try_cast(dreb_pct as double) as defensive_rebound_percentage,
        try_cast(reb_pct as double) as rebound_percentage,
        cast(null as double) as turnover_ratio,
        try_cast(efg_pct as double) as effective_field_goal_percentage,
        try_cast(ts_pct as double) as true_shooting_percentage,
        try_cast(usg_pct as double) as usage_percentage,
        try_cast(e_usg_pct as double) as estimated_usage_percentage,
        try_cast(e_pace as double) as estimated_pace,
        try_cast(pace as double) as pace,
        try_cast(pace_per40 as double) as pace_per40,
        try_cast(poss as double) as possessions,
        try_cast(pie as double) as pie,
        _ingest_date,
        _source_file
    from {{ ref('stats_playergamelogs') }}
    where request_key like 'advanced-%' and game_id is not null and player_id is not null

),

from_v3 as (

    select
        league,
        season,
        game_id,
        person_id as player_id,
        team_id,
        side,
        {{ minutes_to_decimal('minutes') }} as minutes,
        try_cast(estimated_offensive_rating as double) as estimated_offensive_rating,
        try_cast(offensive_rating as double) as offensive_rating,
        try_cast(estimated_defensive_rating as double) as estimated_defensive_rating,
        try_cast(defensive_rating as double) as defensive_rating,
        try_cast(estimated_net_rating as double) as estimated_net_rating,
        try_cast(net_rating as double) as net_rating,
        try_cast(assist_percentage as double) as assist_percentage,
        try_cast(assist_to_turnover as double) as assist_to_turnover,
        try_cast(assist_ratio as double) as assist_ratio,
        try_cast(offensive_rebound_percentage as double) as offensive_rebound_percentage,
        try_cast(defensive_rebound_percentage as double) as defensive_rebound_percentage,
        try_cast(rebound_percentage as double) as rebound_percentage,
        try_cast(turnover_ratio as double) as turnover_ratio,
        try_cast(effective_field_goal_percentage as double) as effective_field_goal_percentage,
        try_cast(true_shooting_percentage as double) as true_shooting_percentage,
        try_cast(usage_percentage as double) as usage_percentage,
        try_cast(estimated_usage_percentage as double) as estimated_usage_percentage,
        try_cast(estimated_pace as double) as estimated_pace,
        try_cast(pace as double) as pace,
        try_cast(pace_per40 as double) as pace_per40,
        try_cast(possessions as double) as possessions,
        try_cast(pie as double) as pie,
        _ingest_date,
        _source_file
    from {{ ref('stats_boxscoreadvancedv3') }}
    where game_id is not null and person_id is not null

),

unioned as (

    select * from from_gamelog
    union all
    select * from from_v3

)

select
    *,
    league || ':' || game_id || ':' || player_id as player_game_key
from unioned
qualify row_number() over (partition by league, game_id, player_id order by _ingest_date desc, _source_file desc) = 1
