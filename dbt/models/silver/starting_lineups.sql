{#
  The NBA's starting lineups per game day, from the latest file landed for the day: one row per
  player per game. A starter is a player the file gives a position; lineup_status is Expected
  until the team confirms it (Confirmed, about half an hour before tip-off); roster_status
  Inactive marks a player ruled out of the game.
#}

with listed as (

    select
        *,
        cast(substr(request_key, 1, 10) as date) as game_date
    from {{ ref('league_daily_lineups') }}
    where player_id is not null

),

latest as (

    select *
    from listed
    qualify request_key = max(request_key) over (partition by league, game_date)

)

select
    league || ':' || game_id || ':' || player_id as lineup_key,
    league,
    season,
    game_date,
    game_id,
    team_id,
    player_id,
    player_name,
    nullif(position, '') as position,
    coalesce(position, '') <> '' as is_starter,
    lineup_status,
    lineup_status = 'Confirmed' as is_confirmed,
    roster_status,
    roster_status = 'Inactive' as is_inactive,
    updated_at,
    request_key as file_key
from latest
qualify row_number() over (partition by league, game_id, player_id order by _source_file desc) = 1
