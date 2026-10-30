{#
  One row per player per game: the player's share of the team's box score while on the floor,
  from the season game log's Usage measure set (one request per season and season type, both
  leagues). Shares are decimals 0-1. Latest landing wins.
#}

select
    league,
    season,
    game_id,
    player_id,
    team_id,
    league || ':' || game_id || ':' || player_id as player_game_key,
    try_cast(min as double) as minutes,
    try_cast(usg_pct as double) as usage_percentage,
    try_cast(pct_fgm as double) as team_share_field_goals_made,
    try_cast(pct_fga as double) as team_share_field_goals_attempted,
    try_cast(pct_fg3m as double) as team_share_three_pointers_made,
    try_cast(pct_fg3a as double) as team_share_three_pointers_attempted,
    try_cast(pct_ftm as double) as team_share_free_throws_made,
    try_cast(pct_fta as double) as team_share_free_throws_attempted,
    try_cast(pct_oreb as double) as team_share_rebounds_offensive,
    try_cast(pct_dreb as double) as team_share_rebounds_defensive,
    try_cast(pct_reb as double) as team_share_rebounds,
    try_cast(pct_ast as double) as team_share_assists,
    try_cast(pct_tov as double) as team_share_turnovers,
    try_cast(pct_stl as double) as team_share_steals,
    try_cast(pct_blk as double) as team_share_blocks,
    try_cast(pct_blka as double) as team_share_blocks_against,
    try_cast(pct_pf as double) as team_share_fouls_personal,
    try_cast(pct_pfd as double) as team_share_fouls_drawn,
    try_cast(pct_pts as double) as team_share_points,
    _ingest_date,
    _source_file
from {{ ref('stats_playergamelogs_usage') }}
where game_id is not null and player_id is not null
qualify row_number() over (partition by league, game_id, player_id order by _ingest_date desc, _source_file desc) = 1
