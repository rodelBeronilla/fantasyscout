{#
  How many games a listed player then misses, by league, status and reason: the histogram the
  board's availability multiplier reads (ADR 0003, 2026-11-01 addendum).

  One row per league served, status, reason group and number of games missed, with the past
  listings that missed exactly that many (fct_official_listing). A league reads its own listings
  once it has calibration_min_listings (300) for the status and reason; until then the NBA's
  stand in, since the WNBA archive only starts in 2026, and source_league says whose they are.
  The board joins a listed player to the rows for their league, status and reason, caps each
  games_missed at the games the team has left and takes the listings-weighted mean; the game
  context notebook shows the same rows. own_listings is the league's own count for the status
  and reason, the number the switch is made on.
#}

with listings as (

    select league, status, reason_group, games_missed, count(*) as listings
    from {{ ref('fct_official_listing') }}
    where status in ('Out', 'Doubtful', 'Questionable', 'Probable') and games_missed is not null
    group by league, status, reason_group, games_missed

),

totals as (

    -- every listing counts toward the switch, including one whose games missed is not known yet
    select league, status, reason_group, count(*) as listings
    from {{ ref('fct_official_listing') }}
    where status in ('Out', 'Doubtful', 'Questionable', 'Probable')
    group by league, status, reason_group

),

served as (

    -- which league's histogram serves each league, status and reason
    select
        l.league,
        k.status,
        k.reason_group,
        coalesce(own.listings, 0) as own_listings,
        case when coalesce(own.listings, 0) >= {{ var('calibration_min_listings') }} then l.league else 'nba' end as source_league
    from (select distinct league from {{ ref('teams') }}) as l
    cross join (select distinct status, reason_group from listings) as k
    left join totals as own
        on own.league = l.league and own.status = k.status and own.reason_group = k.reason_group

)

select
    {{ sk(['s.league', 's.status', 's.reason_group', 'cast(h.games_missed as string)']) }} as status_calibration_sk,
    s.league,
    s.status,
    s.reason_group,
    s.source_league,
    h.games_missed,
    h.listings,
    s.own_listings
from served as s
join listings as h
    on h.league = s.source_league and h.status = s.status and h.reason_group = s.reason_group
