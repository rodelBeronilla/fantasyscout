{#
  Player x game tracking and hustle totals, NBA only (the WNBA host serves no tracking). The
  source reports by game date; a player plays at most one game a day, so the game is the one the
  player's box score puts on that date. The source's team is the player's team when it was
  fetched, not on the game date (a player traded since shows the new team), so the game and the
  team come from the box score, never from the tracking row. These are inputs for later
  backtests; no projection reads them yet.
#}

with tracking as (

    select * from {{ ref('player_day_tracking') }}

),

box as (

    select b.league, b.season, b.game_id, g.game_date, b.player_id, b.team_id, b.side
    from {{ ref('player_game_box') }} as b
    inner join {{ ref('games') }} as g
        on g.league = b.league and g.game_id = b.game_id

),

stint as (

    select league, stats_player_id, player_sk, valid_from, valid_to
    from {{ ref('dim_player') }}

)

select
    {{ sk(['t.league', 'g.game_id', 't.player_id']) }} as player_game_sk,
    s.player_sk,
    {{ sk(['t.league', 'g.game_id']) }} as game_sk,
    {{ sk(['t.league', 'g.season', 'g.team_id']) }} as team_sk,
    t.league,
    g.season,
    g.game_id,
    t.game_date,
    t.player_id,
    g.team_id,
    g.side = 'home' as is_home,
    t.minutes,
    t.passes_made,
    t.passes_received,
    t.tracking_assists,
    t.free_throw_assists,
    t.secondary_assists,
    t.potential_assists,
    t.assist_points_created,
    t.adjusted_assists,
    t.assist_to_pass_percentage,
    t.offensive_rebounds_contested,
    t.offensive_rebound_chances,
    t.defensive_rebounds_contested,
    t.defensive_rebound_chances,
    t.tracking_rebounds,
    t.rebounds_contested,
    t.rebounds_uncontested,
    t.rebound_chances,
    t.rebound_chances_deferred,
    t.average_rebound_distance,
    t.touches,
    t.front_court_touches,
    t.time_of_possession,
    t.average_seconds_per_touch,
    t.average_dribbles_per_touch,
    t.elbow_touches,
    t.post_touches,
    t.paint_touches,
    t.tracking_points,
    t.drives,
    t.drive_field_goals_made,
    t.drive_field_goals_attempted,
    t.drive_free_throws_attempted,
    t.drive_points,
    t.drive_passes,
    t.drive_assists,
    t.drive_turnovers,
    t.drive_fouls_drawn,
    t.distance_miles,
    t.distance_miles_offense,
    t.distance_miles_defense,
    t.average_speed,
    t.average_speed_offense,
    t.average_speed_defense,
    t.contested_shots,
    t.contested_shots_2pt,
    t.contested_shots_3pt,
    t.deflections,
    t.charges_drawn,
    t.screen_assists,
    t.screen_assist_points,
    t.loose_balls_recovered_offensive,
    t.loose_balls_recovered_defensive,
    t.loose_balls_recovered,
    t.box_outs_offensive,
    t.box_outs_defensive,
    t.box_outs,
    t.box_outs_team_rebounds,
    t.box_outs_own_rebounds,
    t._ingest_date
from tracking as t
inner join box as g
    on g.league = t.league and g.game_date = t.game_date and g.player_id = t.player_id
left join stint as s
    on s.league = t.league and s.stats_player_id = t.player_id
    and t.game_date >= s.valid_from and (s.valid_to is null or t.game_date <= s.valid_to)
