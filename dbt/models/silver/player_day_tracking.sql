{#
  One row per NBA player per game date: player tracking (passing, rebounding, touches, drives,
  speed and distance) and hustle totals. The source has no per-game form, so each set is landed
  one game date at a time (request keys like passing-2026-01-15); a player plays at most one game
  a day, so a player-date is a player-game. Each set keeps its latest landing per player and
  date; the sets are joined on every player-date any of them reports (the rebounding set leaves
  out players with no rebound chance, and hustle starts in 2015-16, so their columns can be null).
  The WNBA host serves none of this.
#}

with passing as (

    select
        league,
        season,
        right(request_key, 10) as game_day,
        player_id,
        team_id,
        try_cast(min as double) as minutes,
        try_cast(try_cast(passes_made as double) as integer) as passes_made,
        try_cast(try_cast(passes_received as double) as integer) as passes_received,
        try_cast(try_cast(ast as double) as integer) as tracking_assists,
        try_cast(try_cast(ft_ast as double) as integer) as free_throw_assists,
        try_cast(try_cast(secondary_ast as double) as integer) as secondary_assists,
        try_cast(try_cast(potential_ast as double) as integer) as potential_assists,
        try_cast(try_cast(ast_pts_created as double) as integer) as assist_points_created,
        try_cast(try_cast(ast_adj as double) as integer) as adjusted_assists,
        try_cast(ast_to_pass_pct as double) as assist_to_pass_percentage,
        _ingest_date
    from {{ ref('stats_leaguedashptstats_passing') }}
    where player_id is not null
    qualify row_number() over (partition by league, request_key, player_id order by _ingest_date desc, _source_file desc) = 1

),

rebounding as (

    select
        league,
        season,
        right(request_key, 10) as game_day,
        player_id,
        team_id,
        try_cast(min as double) as minutes,
        try_cast(try_cast(oreb_contest as double) as integer) as offensive_rebounds_contested,
        try_cast(try_cast(oreb_chances as double) as integer) as offensive_rebound_chances,
        try_cast(try_cast(dreb_contest as double) as integer) as defensive_rebounds_contested,
        try_cast(try_cast(dreb_chances as double) as integer) as defensive_rebound_chances,
        try_cast(try_cast(reb as double) as integer) as tracking_rebounds,
        try_cast(try_cast(reb_contest as double) as integer) as rebounds_contested,
        try_cast(try_cast(reb_uncontest as double) as integer) as rebounds_uncontested,
        try_cast(try_cast(reb_chances as double) as integer) as rebound_chances,
        try_cast(try_cast(reb_chance_defer as double) as integer) as rebound_chances_deferred,
        try_cast(avg_reb_dist as double) as average_rebound_distance,
        _ingest_date
    from {{ ref('stats_leaguedashptstats_rebounding') }}
    where player_id is not null
    qualify row_number() over (partition by league, request_key, player_id order by _ingest_date desc, _source_file desc) = 1

),

possessions as (

    select
        league,
        season,
        right(request_key, 10) as game_day,
        player_id,
        team_id,
        try_cast(min as double) as minutes,
        try_cast(try_cast(touches as double) as integer) as touches,
        try_cast(try_cast(front_ct_touches as double) as integer) as front_court_touches,
        try_cast(time_of_poss as double) as time_of_possession,
        try_cast(avg_sec_per_touch as double) as average_seconds_per_touch,
        try_cast(avg_drib_per_touch as double) as average_dribbles_per_touch,
        try_cast(try_cast(elbow_touches as double) as integer) as elbow_touches,
        try_cast(try_cast(post_touches as double) as integer) as post_touches,
        try_cast(try_cast(paint_touches as double) as integer) as paint_touches,
        try_cast(try_cast(points as double) as integer) as tracking_points,
        _ingest_date
    from {{ ref('stats_leaguedashptstats_possessions') }}
    where player_id is not null
    qualify row_number() over (partition by league, request_key, player_id order by _ingest_date desc, _source_file desc) = 1

),

drives as (

    select
        league,
        season,
        right(request_key, 10) as game_day,
        player_id,
        team_id,
        try_cast(min as double) as minutes,
        try_cast(try_cast(drives as double) as integer) as drives,
        try_cast(try_cast(drive_fgm as double) as integer) as drive_field_goals_made,
        try_cast(try_cast(drive_fga as double) as integer) as drive_field_goals_attempted,
        try_cast(try_cast(drive_fta as double) as integer) as drive_free_throws_attempted,
        try_cast(try_cast(drive_pts as double) as integer) as drive_points,
        try_cast(try_cast(drive_passes as double) as integer) as drive_passes,
        try_cast(try_cast(drive_ast as double) as integer) as drive_assists,
        try_cast(try_cast(drive_tov as double) as integer) as drive_turnovers,
        try_cast(try_cast(drive_pf as double) as integer) as drive_fouls_drawn,
        _ingest_date
    from {{ ref('stats_leaguedashptstats_drives') }}
    where player_id is not null
    qualify row_number() over (partition by league, request_key, player_id order by _ingest_date desc, _source_file desc) = 1

),

speeddistance as (

    select
        league,
        season,
        right(request_key, 10) as game_day,
        player_id,
        team_id,
        try_cast(min as double) as minutes,
        try_cast(dist_miles as double) as distance_miles,
        try_cast(dist_miles_off as double) as distance_miles_offense,
        try_cast(dist_miles_def as double) as distance_miles_defense,
        try_cast(avg_speed as double) as average_speed,
        try_cast(avg_speed_off as double) as average_speed_offense,
        try_cast(avg_speed_def as double) as average_speed_defense,
        _ingest_date
    from {{ ref('stats_leaguedashptstats_speeddistance') }}
    where player_id is not null
    qualify row_number() over (partition by league, request_key, player_id order by _ingest_date desc, _source_file desc) = 1

),

hustle as (

    select
        league,
        season,
        right(request_key, 10) as game_day,
        player_id,
        team_id,
        try_cast(min as double) as minutes,
        try_cast(try_cast(contested_shots as double) as integer) as contested_shots,
        try_cast(try_cast(contested_shots_2pt as double) as integer) as contested_shots_2pt,
        try_cast(try_cast(contested_shots_3pt as double) as integer) as contested_shots_3pt,
        try_cast(try_cast(deflections as double) as integer) as deflections,
        try_cast(try_cast(charges_drawn as double) as integer) as charges_drawn,
        try_cast(try_cast(screen_assists as double) as integer) as screen_assists,
        try_cast(try_cast(screen_ast_pts as double) as integer) as screen_assist_points,
        try_cast(try_cast(off_loose_balls_recovered as double) as integer) as loose_balls_recovered_offensive,
        try_cast(try_cast(def_loose_balls_recovered as double) as integer) as loose_balls_recovered_defensive,
        try_cast(try_cast(loose_balls_recovered as double) as integer) as loose_balls_recovered,
        try_cast(try_cast(off_boxouts as double) as integer) as box_outs_offensive,
        try_cast(try_cast(def_boxouts as double) as integer) as box_outs_defensive,
        try_cast(try_cast(box_outs as double) as integer) as box_outs,
        try_cast(try_cast(box_out_player_team_rebs as double) as integer) as box_outs_team_rebounds,
        try_cast(try_cast(box_out_player_rebs as double) as integer) as box_outs_own_rebounds,
        _ingest_date
    from {{ ref('stats_leaguehustlestatsplayer') }}
    where player_id is not null
    qualify row_number() over (partition by league, request_key, player_id order by _ingest_date desc, _source_file desc) = 1

),

player_days as (

    select league, season, game_day, player_id, team_id from passing
    union
    select league, season, game_day, player_id, team_id from rebounding
    union
    select league, season, game_day, player_id, team_id from possessions
    union
    select league, season, game_day, player_id, team_id from drives
    union
    select league, season, game_day, player_id, team_id from speeddistance
    union
    select league, season, game_day, player_id, team_id from hustle

),

ranked as (

    select
        player_days.*,
        row_number() over (partition by league, game_day, player_id order by team_id) as team_rank
    from player_days

),

spine as (

    select
        league,
        season,
        game_day,
        player_id,
        team_id
    from ranked
    where team_rank = 1

)

select
    spine.league,
    spine.season,
    cast(spine.game_day as date) as game_date,
    spine.player_id,
    spine.team_id,
    spine.league || ':' || spine.game_day || ':' || spine.player_id as player_day_key,
    coalesce(
        passing.minutes,
        rebounding.minutes,
        possessions.minutes,
        drives.minutes,
        speeddistance.minutes,
        hustle.minutes
    ) as minutes,
    passing.passes_made,
    passing.passes_received,
    passing.tracking_assists,
    passing.free_throw_assists,
    passing.secondary_assists,
    passing.potential_assists,
    passing.assist_points_created,
    passing.adjusted_assists,
    passing.assist_to_pass_percentage,
    rebounding.offensive_rebounds_contested,
    rebounding.offensive_rebound_chances,
    rebounding.defensive_rebounds_contested,
    rebounding.defensive_rebound_chances,
    rebounding.tracking_rebounds,
    rebounding.rebounds_contested,
    rebounding.rebounds_uncontested,
    rebounding.rebound_chances,
    rebounding.rebound_chances_deferred,
    rebounding.average_rebound_distance,
    possessions.touches,
    possessions.front_court_touches,
    possessions.time_of_possession,
    possessions.average_seconds_per_touch,
    possessions.average_dribbles_per_touch,
    possessions.elbow_touches,
    possessions.post_touches,
    possessions.paint_touches,
    possessions.tracking_points,
    drives.drives,
    drives.drive_field_goals_made,
    drives.drive_field_goals_attempted,
    drives.drive_free_throws_attempted,
    drives.drive_points,
    drives.drive_passes,
    drives.drive_assists,
    drives.drive_turnovers,
    drives.drive_fouls_drawn,
    speeddistance.distance_miles,
    speeddistance.distance_miles_offense,
    speeddistance.distance_miles_defense,
    speeddistance.average_speed,
    speeddistance.average_speed_offense,
    speeddistance.average_speed_defense,
    hustle.contested_shots,
    hustle.contested_shots_2pt,
    hustle.contested_shots_3pt,
    hustle.deflections,
    hustle.charges_drawn,
    hustle.screen_assists,
    hustle.screen_assist_points,
    hustle.loose_balls_recovered_offensive,
    hustle.loose_balls_recovered_defensive,
    hustle.loose_balls_recovered,
    hustle.box_outs_offensive,
    hustle.box_outs_defensive,
    hustle.box_outs,
    hustle.box_outs_team_rebounds,
    hustle.box_outs_own_rebounds,
    greatest(
        coalesce(passing._ingest_date, cast('1900-01-01' as date)),
        coalesce(rebounding._ingest_date, cast('1900-01-01' as date)),
        coalesce(possessions._ingest_date, cast('1900-01-01' as date)),
        coalesce(drives._ingest_date, cast('1900-01-01' as date)),
        coalesce(speeddistance._ingest_date, cast('1900-01-01' as date)),
        coalesce(hustle._ingest_date, cast('1900-01-01' as date))
    ) as _ingest_date
from spine
left join passing
    on passing.league = spine.league and passing.game_day = spine.game_day and passing.player_id = spine.player_id
left join rebounding
    on rebounding.league = spine.league and rebounding.game_day = spine.game_day and rebounding.player_id = spine.player_id
left join possessions
    on possessions.league = spine.league and possessions.game_day = spine.game_day and possessions.player_id = spine.player_id
left join drives
    on drives.league = spine.league and drives.game_day = spine.game_day and drives.player_id = spine.player_id
left join speeddistance
    on speeddistance.league = spine.league and speeddistance.game_day = spine.game_day and speeddistance.player_id = spine.player_id
left join hustle
    on hustle.league = spine.league and hustle.game_day = spine.game_day and hustle.player_id = spine.player_id
