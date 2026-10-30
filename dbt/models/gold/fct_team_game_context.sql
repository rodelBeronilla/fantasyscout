{#
  The circumstances of each team's games, played and scheduled: days of rest before the game,
  the second night of a back-to-back, a third game in four nights, the miles travelled from the
  previous game's city, the time zones crossed, and the altitude of the venue.

  The venue is the game's arena city (silver.schedule), placed by the venues seed (latitude,
  longitude, elevation, standard UTC offset); a city missing from the seed leaves travel and
  altitude null and warn_venue_cities lists it. Travel is the great-circle distance between the
  two venues, so a home stand after a road trip counts the flight home. Only regular-season,
  play-in, playoff and cup-final games count, and an "if necessary" game is left out until it is
  confirmed, as is a knockout game whose teams are not decided yet (the schedule lists them as 0).
#}

with sides as (

    select league, season, game_id, game_date_est as game_date, game_type, arena_city, is_neutral,
        home_team_id as team_id, away_team_id as opponent_id, true as is_home
    from {{ ref('schedule') }}
    where game_type in ('regular', 'play_in', 'playoffs', 'tournament_final') and not coalesce(if_necessary, false)
        and coalesce(home_team_id, '0') <> '0' and coalesce(away_team_id, '0') <> '0'
    union all
    select league, season, game_id, game_date_est, game_type, arena_city, is_neutral,
        away_team_id, home_team_id, false
    from {{ ref('schedule') }}
    where game_type in ('regular', 'play_in', 'playoffs', 'tournament_final') and not coalesce(if_necessary, false)
        and coalesce(home_team_id, '0') <> '0' and coalesce(away_team_id, '0') <> '0'

),

placed as (

    select
        s.*,
        v.latitude,
        v.longitude,
        v.elevation_ft,
        v.utc_offset,
        {{ days_between("cast('2000-01-01' as date)", 's.game_date') }} as day_number
    from sides as s
    left join {{ ref('venues') }} as v on lower(v.city) = lower(s.arena_city)

),

sequenced as (

    select
        *,
        lag(game_date) over (partition by league, season, team_id order by game_date, game_id) as previous_date,
        lag(latitude) over (partition by league, season, team_id order by game_date, game_id) as previous_latitude,
        lag(longitude) over (partition by league, season, team_id order by game_date, game_id) as previous_longitude,
        lag(utc_offset) over (partition by league, season, team_id order by game_date, game_id) as previous_utc_offset,
        count(*) over (
            partition by league, season, team_id order by day_number range between 3 preceding and current row
        ) as games_in_4_nights
    from placed

),

measured as (

    select
        *,
        {{ days_between('previous_date', 'game_date') }} - 1 as rest_days,
        3958.8 * 2 * asin(sqrt(
            power(sin(radians(latitude - previous_latitude) / 2), 2)
            + cos(radians(previous_latitude)) * cos(radians(latitude))
                * power(sin(radians(longitude - previous_longitude) / 2), 2)
        )) as miles_travelled,
        utc_offset - previous_utc_offset as time_zones_crossed
    from sequenced

)

select
    {{ sk(['m.league', 'm.game_id', 'm.team_id']) }} as team_game_context_sk,
    m.league,
    m.season,
    m.game_id,
    m.game_date,
    m.game_type,
    m.team_id,
    m.opponent_id,
    m.is_home,
    m.arena_city,
    m.rest_days,
    coalesce(m.rest_days = 0, false) as is_back_to_back,
    m.games_in_4_nights >= 3 as is_3_in_4,
    cast(round(m.miles_travelled, 0) as integer) as miles_travelled,
    m.time_zones_crossed,
    m.elevation_ft,
    coalesce(m.elevation_ft >= 4000, false) as at_altitude,
    coalesce(o.rest_days = 0, false) as opponent_back_to_back,
    o.rest_days as opponent_rest_days
from measured as m
left join measured as o on o.league = m.league and o.game_id = m.game_id and o.team_id = m.opponent_id
