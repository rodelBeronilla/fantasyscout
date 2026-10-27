{#
  League stats API game id to ESPN event id, one row per matched game. A game and an event
  match when they are in the same league, between the same two teams (through team_xwalk, in
  either orientation so neutral-site games match), on the same Eastern-time date; a game
  without a same-day event takes one on the adjacent day. Each event is used at most once.
#}

with games as (

    select
        g.league,
        g.season,
        g.game_id,
        g.game_date,
        th.espn_team_id as espn_home_team_id,
        ta.espn_team_id as espn_away_team_id
    from {{ ref('games') }} as g
    left join {{ ref('team_xwalk') }} as th
        on th.league = g.league and th.stats_team_id = g.home_team_id
    left join {{ ref('team_xwalk') }} as ta
        on ta.league = g.league and ta.stats_team_id = g.away_team_id

),

events as (

    select
        league,
        event_id,
        {{ utc_to_eastern_date('event_datetime_utc') }} as event_date_et,
        home_team_id,
        away_team_id
    from {{ ref('espn_events') }}

),

candidates as (

    select
        g.league,
        g.season,
        g.game_id,
        g.game_date,
        e.event_id,
        e.event_date_et,
        abs({{ days_between('e.event_date_et', 'g.game_date') }}) as day_gap,
        e.home_team_id = g.espn_home_team_id as same_orientation
    from games as g
    join events as e
        on e.league = g.league
        and (
            (e.home_team_id = g.espn_home_team_id and e.away_team_id = g.espn_away_team_id)
            or (e.home_team_id = g.espn_away_team_id and e.away_team_id = g.espn_home_team_id)
        )
        and abs({{ days_between('e.event_date_et', 'g.game_date') }}) <= 1

),

ranked as (

    select
        *,
        row_number() over (
            partition by league, game_id
            order by day_gap, case when same_orientation then 0 else 1 end, event_id
        ) as rk_game,
        row_number() over (
            partition by league, event_id
            order by day_gap, case when same_orientation then 0 else 1 end, game_id
        ) as rk_event
    from candidates

)

select
    league,
    season,
    game_id,
    event_id,
    league || ':' || game_id as game_xwalk_key,
    game_date,
    event_date_et,
    case when day_gap = 0 then 'same_day' else 'adjacent_day' end as method
from ranked
where rk_game = 1 and rk_event = 1
