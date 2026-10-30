{# The league's regular-season standings per team, from the latest landing per league-season. #}

select
    league,
    season,
    team_id,
    league || ':' || season || ':' || team_id as standings_key,
    team_city,
    team_name,
    conference,
    try_cast(playoff_rank as integer) as playoff_rank,
    nullif(trim(replace(clinch_indicator, '-', '')), '') as clinch_indicator,
    try_cast(wins as integer) as wins,
    try_cast(losses as integer) as losses,
    try_cast(win_pct as double) as win_pct,
    last_10,
    trim(current_streak) as current_streak,
    try_cast(conference_games_back as double) as conference_games_back,
    coalesce(try_cast(clinched_conference as integer), 0) = 1 as clinched_conference,
    coalesce(try_cast(clinched_playoffs as integer), 0) = 1 as clinched_playoffs,
    coalesce(try_cast(clinched_play_in as integer), 0) = 1 as clinched_play_in,
    coalesce(try_cast(eliminated as integer), 0) = 1 as eliminated,
    cast(_ingest_date as date) as observed_date
from {{ ref('stats_leaguestandingsv3') }}
where team_id is not null
qualify row_number() over (partition by league, season, team_id order by _ingest_date desc, _source_file desc) = 1
