{#
  Streaming candidates: one row per player active in the league's current season, with the
  team's games over the next seven days, the minutes trend and recent production.

  Active means at least three games this season and a game within the last thirty days of
  the league's season so far, so players from earlier seasons never appear. The trend compares
  the last five games with the player's season average (minutes and value); while the league is
  between seasons the same columns describe who finished the season strongly, and
  season_complete says so.
#}

with current_season as (

    select league, max(season) as season
    from {{ ref('fct_player_game') }}
    group by league

),

league_last_game as (

    select g.league, max(g.game_date) as last_game_date
    from {{ ref('fct_player_game') }} as g
    join current_season as cs on cs.league = g.league and cs.season = g.season
    where g.played
    group by g.league

),

latest_rolling as (

    select r.*
    from {{ ref('mart_player_rolling') }} as r
    join current_season as cs on cs.league = r.league and cs.season = r.season
    qualify row_number() over (partition by r.league, r.player_id order by r.game_date desc, r.game_id desc) = 1

),

season_line as (

    select z.league, z.player_id, z.games, z.minutes_pg, z.z_total as season_z_total
    from {{ ref('mart_category_zscores') }} as z
    join current_season as cs on cs.league = z.league and cs.season = z.season
    where z.window_name = 'season'

),

recent_value as (

    select z.league, z.player_id, z.z_total as last_10_z_total
    from {{ ref('mart_category_zscores') }} as z
    join current_season as cs on cs.league = z.league and cs.season = z.season
    where z.window_name = 'last_10'

),

upcoming as (

    select league, team_id, cast(count(*) as integer) as games_next_7
    from (
        select league, home_team_id as team_id, days_ahead from {{ ref('mart_schedule_upcoming') }}
        union all
        select league, away_team_id as team_id, days_ahead from {{ ref('mart_schedule_upcoming') }}
    ) as sides
    where days_ahead < 7
    group by league, team_id

),

league_state as (

    select cs.league, coalesce(sum(u.games_next_7), 0) = 0 as season_complete
    from current_season as cs
    left join upcoming as u on u.league = cs.league
    group by cs.league

),

injury as (

    select league, stats_player_id, status, status_group
    from {{ ref('fct_availability') }}
    where is_current and stats_player_id is not null
    qualify row_number() over (
        partition by league, stats_player_id
        order by case status_group when 'out' then 0 when 'doubtful' then 1 when 'questionable' then 2 when 'day_to_day' then 3 else 4 end
    ) = 1

),

current_stint as (

    select league, stats_player_id, player_sk, team_id, full_name, position
    from {{ ref('dim_player') }}
    where is_current

)

select
    {{ sk(['lr.league', 'lr.player_id']) }} as streamer_sk,
    lr.league,
    lr.player_id,
    cs.player_sk,
    cs.full_name,
    cs.position,
    cs.team_id,
    t.abbreviation as team_abbreviation,
    lr.season,
    ls.season_complete,
    cast(coalesce(u.games_next_7, 0) as integer) as games_next_7,
    lr.game_date as last_game_date,
    sl.games as games_season,
    lr.games_in_window_5,
    sl.minutes_pg as minutes_season,
    lr.minutes_avg_5,
    lr.minutes_avg_10,
    lr.minutes_avg_5 - sl.minutes_pg as minutes_trend,
    sl.season_z_total,
    rv.last_10_z_total,
    rv.last_10_z_total - sl.season_z_total as value_trend,
    lr.points_avg_5,
    lr.rebounds_total_avg_5,
    lr.assists_avg_5,
    lr.steals_avg_5,
    lr.blocks_avg_5,
    lr.three_pointers_made_avg_5,
    lr.turnovers_avg_5,
    lr.field_goal_pct_5,
    lr.free_throw_pct_5,
    i.status as injury_status,
    i.status_group as injury_group
from latest_rolling as lr
join league_last_game as llg on llg.league = lr.league
join league_state as ls on ls.league = lr.league
left join season_line as sl on sl.league = lr.league and sl.player_id = lr.player_id
left join recent_value as rv on rv.league = lr.league and rv.player_id = lr.player_id
left join current_stint as cs on cs.league = lr.league and cs.stats_player_id = lr.player_id
left join {{ ref('teams') }} as t on t.league = lr.league and t.season = lr.season and t.team_id = cs.team_id
left join upcoming as u on u.league = lr.league and u.team_id = cs.team_id
left join injury as i on i.league = lr.league and i.stats_player_id = lr.player_id
where sl.games >= 3
    and lr.game_date >= {{ add_days('llg.last_game_date', -30) }}
