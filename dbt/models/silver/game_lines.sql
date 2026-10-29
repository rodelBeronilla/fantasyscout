{#
  The betting line for each ESPN event: the point spread from the home side (negative when the
  home team is favoured), the over/under, and the points each team is implied to score. Upcoming
  games take the line from the latest scoreboard; a finished game's summary carries the closing
  line, which wins over any earlier scoreboard. One row per event that has a line.
#}

with lines as (

    select league, season, event_id, _ingest_date, _source_file, provider, details, spread, over_under,
        home_moneyline, away_moneyline, 1 as source_rank
    from {{ ref('espn_summary_odds') }}
    where spread is not null or over_under is not null
    union all
    select league, season, event_id, _ingest_date, _source_file, provider, details, spread, over_under,
        home_moneyline, away_moneyline, 2 as source_rank
    from {{ ref('espn_scoreboard_odds') }}
    where spread is not null or over_under is not null

),

latest as (

    select *
    from lines
    where event_id is not null
    qualify row_number() over (
        partition by league, event_id
        order by source_rank, _ingest_date desc, _source_file desc
    ) = 1

),

typed as (

    select
        l.league,
        l.season,
        l.event_id,
        l.league || ':' || l.event_id as event_key,
        e.event_date,
        {{ utc_to_eastern_date('e.event_datetime_utc') }} as event_date_et,
        e.home_team_id as espn_home_team_id,
        e.away_team_id as espn_away_team_id,
        l.provider,
        l.details,
        try_cast(l.spread as double) as home_spread,
        try_cast(l.over_under as double) as over_under,
        try_cast(replace(l.home_moneyline, '+', '') as integer) as home_moneyline,
        try_cast(replace(l.away_moneyline, '+', '') as integer) as away_moneyline,
        case when l.source_rank = 1 then 'closing' else 'latest' end as line_type,
        cast(l._ingest_date as date) as observed_date
    from latest as l
    join {{ ref('espn_events') }} as e on e.league = l.league and e.event_id = l.event_id

)

select
    *,
    -- A team's implied points: half the total, plus half the spread in its favour.
    (over_under - home_spread) / 2 as home_implied_points,
    (over_under + home_spread) / 2 as away_implied_points
from typed
