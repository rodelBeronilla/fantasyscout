{#
  The games of the next fourteen days per league, for the Streamers week grid and the board's
  games-next-seven column. Only regular-season and playoff games count, and an "if necessary"
  playoff game is left out until it is confirmed (the league stops flagging it once it is on).
#}

select
    {{ sk(['s.league', 's.game_id']) }} as upcoming_sk,
    s.league,
    s.season,
    s.game_id,
    s.game_date_est as game_date,
    {{ days_between(as_of_date(), 's.game_date_est') }} as days_ahead,
    s.game_type,
    s.home_team_id,
    s.home_team_tricode,
    s.away_team_id,
    s.away_team_tricode,
    s.game_datetime_utc
from {{ ref('schedule') }} as s
where s.game_status <> 3
    and s.game_type in ('regular', 'playoffs')
    and not coalesce(s.if_necessary, false)
    and s.game_date_est >= {{ as_of_date() }}
    and s.game_date_est < {{ add_days(as_of_date(), 14) }}
