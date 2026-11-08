{#
  Who is on which team, as the build knows it (#796): what mart_player_projection projects.

  A normal build reads the official rosters: each league's latest roster season, each team's
  latest landing, and for a player on two teams' latest landings the newer one, with the age and
  rookie flag the roster gives.

  A point-in-time build cannot. Rosters count as known only from the day they were landed
  (ADR 0018), and every past season's were landed by a backfill long after it, so a backtest of a
  past date would project nobody. It rebuilds the roster from what was known before the cut instead:
  each player's latest event among the games he played (this season and the last) and the
  league's official signings, trades (the receiving team) and waiver claims. A player whose latest
  event is a waiver is on no roster. The movement feed is the NBA's, so a WNBA roster comes from
  games alone. The roster season is the newest season on the schedule that starts within about
  six months of the cut, so an offseason date projects the coming season. Age and the rookie flag
  are unknown here; mart_board takes the age from the birth date.
#}

-- depends_on: {{ ref('schedule') }}
-- depends_on: {{ ref('fct_player_game') }}
-- depends_on: {{ ref('transactions') }}
-- depends_on: {{ ref('rosters') }}

{% if point_in_time() %}

with starts as (

    select league, season, min(game_date_est) as first_game
    from {{ ref('schedule') }}
    where game_type = 'regular'
    group by league, season

),

roster_season as (

    select league, max(season) as roster_season
    from starts
    where first_game <= {{ add_days(as_of_date(), 183) }}
    group by league

),

window_start as (

    -- events from the start of the season before the roster season
    select r.league, r.roster_season, max(s.first_game) as since
    from roster_season as r
    join starts as s on s.league = r.league and s.season < r.roster_season
    group by r.league, r.roster_season

),

events as (

    select g.league, g.player_id, g.team_id, g.game_date as event_date, 1 as event_order
    from {{ ref('fct_player_game') }} as g
    join window_start as w on w.league = g.league
    where g.played and g.game_date >= w.since

    union all

    select
        t.league,
        t.player_id,
        case when t.transaction_type = 'Waive' then null else t.team_id end as team_id,
        t.transaction_date as event_date,
        -- a move on a game day comes after that day's game
        2 as event_order
    from {{ ref('transactions') }} as t
    join window_start as w on w.league = t.league
    where t.source = 'nba'
        and t.player_id is not null
        and t.transaction_type in ('Signing', 'Trade', 'AwardOnWaivers', 'Waive')
        and t.transaction_date >= w.since

),

latest as (

    select *
    from events
    qualify row_number() over (
        partition by league, player_id order by event_date desc, event_order desc, team_id
    ) = 1

)

select
    l.league,
    r.roster_season,
    l.team_id,
    l.player_id,
    cast(null as integer) as age,
    false as is_rookie
from latest as l
join roster_season as r on r.league = l.league
where l.team_id is not null

{% else %}

with latest_landing as (

    select league, season, team_id, player_id, age, experience, _ingest_date
    from {{ ref('rosters') }}
    qualify season = max(season) over (partition by league)
        and _ingest_date = max(_ingest_date) over (partition by league, season, team_id)

)

-- A player on two teams' latest landings (traded between them) belongs to the newer one.
select league, season as roster_season, team_id, player_id, age,
    -- the league lists a rookie's experience as R
    upper(trim(experience)) = 'R' as is_rookie
from latest_landing
qualify row_number() over (partition by league, player_id order by _ingest_date desc, team_id) = 1

{% endif %}
