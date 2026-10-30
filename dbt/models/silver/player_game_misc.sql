{#
  One row per player per game: points by situation, the same for the opponent while the player
  was on the floor, fouls drawn and blocks against, from the season game log's Misc measure set
  (one request per season and season type, both leagues). Latest landing wins.
#}

select
    league,
    season,
    game_id,
    player_id,
    team_id,
    league || ':' || game_id || ':' || player_id as player_game_key,
    try_cast(min as double) as minutes,
    try_cast(pts_off_tov as integer) as points_off_turnovers,
    try_cast(pts_2nd_chance as integer) as second_chance_points,
    try_cast(pts_fb as integer) as fast_break_points,
    try_cast(pts_paint as integer) as points_in_paint,
    try_cast(opp_pts_off_tov as double) as opponent_points_off_turnovers,
    try_cast(opp_pts_2nd_chance as double) as opponent_second_chance_points,
    try_cast(opp_pts_fb as double) as opponent_fast_break_points,
    try_cast(opp_pts_paint as double) as opponent_points_in_paint,
    try_cast(blk as integer) as blocks,
    try_cast(blka as integer) as blocks_against,
    try_cast(pf as integer) as fouls_personal,
    try_cast(pfd as integer) as fouls_drawn,
    _ingest_date,
    _source_file
from {{ ref('stats_playergamelogs_misc') }}
where game_id is not null and player_id is not null
qualify row_number() over (partition by league, game_id, player_id order by _ingest_date desc, _source_file desc) = 1
