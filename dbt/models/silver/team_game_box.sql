{# One row per team per game, typed, from the league game log. Latest landing wins. #}

select
    league,
    season,
    game_id,
    team_id,
    league || ':' || game_id || ':' || team_id as team_game_key,
    season_id,
    team_abbreviation,
    team_name,
    cast(game_date as date) as game_date,
    matchup,
    case when matchup like '%vs.%' then true when matchup like '%@%' then false end as is_home,
    wl as win_loss,
    try_cast(min as integer) as minutes,
    try_cast(fgm as integer) as field_goals_made,
    try_cast(fga as integer) as field_goals_attempted,
    try_cast(fg3m as integer) as three_pointers_made,
    try_cast(fg3a as integer) as three_pointers_attempted,
    try_cast(ftm as integer) as free_throws_made,
    try_cast(fta as integer) as free_throws_attempted,
    try_cast(oreb as integer) as rebounds_offensive,
    try_cast(dreb as integer) as rebounds_defensive,
    try_cast(reb as integer) as rebounds_total,
    try_cast(ast as integer) as assists,
    try_cast(stl as integer) as steals,
    try_cast(blk as integer) as blocks,
    try_cast(tov as integer) as turnovers,
    try_cast(pf as integer) as fouls_personal,
    try_cast(pts as integer) as points,
    try_cast(plus_minus as integer) as plus_minus,
    _ingest_date,
    _source_file
from {{ ref('stats_leaguegamelog') }}
where game_id is not null and team_id is not null
qualify row_number() over (partition by league, game_id, team_id order by _ingest_date desc, _source_file desc) = 1
