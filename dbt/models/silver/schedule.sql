{#
  One row per scheduled game with status, venue and tip-off time. Latest landing wins.

  The third character of a league game id encodes the game type (1 preseason, 2 regular
  season, 3 All-Star, 4 playoffs, 5 play-in, 6 in-season tournament final); game_type names
  it so downstream models and checks can scope to the types the platform ingests.
#}

select
    league,
    season,
    game_id,
    league || ':' || game_id as game_key,
    season_year,
    game_code,
    case substr(game_id, 3, 1)
        when '1' then 'preseason'
        when '2' then 'regular'
        when '3' then 'all_star'
        when '4' then 'playoffs'
        when '5' then 'play_in'
        when '6' then 'tournament_final'
        else 'other'
    end as game_type,
    try_cast(game_status as integer) as game_status,
    game_status_text,
    cast(substr(game_date_est, 1, 10) as date) as game_date_est,
    game_date_time_utc as game_datetime_utc,
    try_cast(week_number as integer) as week_number,
    week_name,
    cast(if_necessary as boolean) as if_necessary,
    game_label,
    game_sub_label,
    series_text,
    arena_name,
    arena_city,
    arena_state,
    cast(is_neutral as boolean) as is_neutral,
    home_team_id,
    home_team_tricode,
    try_cast(home_score as integer) as home_score,
    away_team_id,
    away_team_tricode,
    try_cast(away_score as integer) as away_score,
    _ingest_date,
    _source_file
from {{ ref('stats_scheduleleaguev2') }}
where game_id is not null
qualify row_number() over (partition by league, game_id order by _ingest_date desc, _source_file desc) = 1
