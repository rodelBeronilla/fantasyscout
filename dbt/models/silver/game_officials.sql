{#
  One row per league, game and official: who officiated each game, and who is assigned to the
  games of the day.

  Two sources. ESPN's game summaries list the crew of every played game (three officials, by
  name, in an order, each called "Referee"); they reach the league game id through game_xwalk.
  The leagues' assignments page (official.nba.com) names each of the day's crews by role (crew
  chief, referee, umpire, and sometimes an alternate) for games it calls "Chicago @ Boston"; a
  page row reaches the league game id by its date and its two teams, named by city, club or
  both ("L.A. Lakers"), matched to the teams seed and the schedule's tricodes.

  A game ESPN has a crew for takes ESPN's list, with the role from the page where the page named
  the same official (an official who stepped in has none); a game ESPN has no crew for yet (an
  upcoming game) takes the page's crew, alternate included. Officials are matched across the two
  sources by name, reduced to lowercase letters.
#}

with espn_latest as (

    select
        o.*,
        dense_rank() over (
            partition by o.league, o.event_id order by o._ingest_date desc, o._source_file desc
        ) as rk
    from {{ ref('espn_summary_officials') }} as o
    where o.full_name is not null

),

espn as (

    select
        x.league,
        x.season,
        x.game_id,
        x.game_date,
        {{ norm_name('o.full_name', keep_suffix=true) }} as official_key,
        o.full_name as official_name,
        try_cast(o.listed_order as integer) as listed_order,
        o._ingest_date
    from espn_latest as o
    join {{ ref('game_xwalk') }} as x
        on x.league = o.league and x.event_id = o.event_id
    where o.rk = 1
    qualify row_number() over (
        partition by x.league, x.game_id, {{ norm_name('o.full_name', keep_suffix=true) }}
        order by try_cast(o.listed_order as integer)
    ) = 1

),

pages as (

    select *
    from {{ ref('league_referee_assignments') }}
    where page_date is not null
    qualify dense_rank() over (
        partition by league, page_date order by _ingest_date desc, _source_file desc
    ) = 1

),

-- Every name a team goes by on the page, reduced like a player name; a name two teams share
-- within a league ("Los Angeles" in the NBA) is dropped.
team_names as (

    select league, abbreviation, label
    from (
        select league, abbreviation, {{ norm_name('city', keep_suffix=true) }} as label from {{ ref('team_reference') }}
        union
        select league, abbreviation, {{ norm_name("city || ' ' || name", keep_suffix=true) }} from {{ ref('team_reference') }}
        union
        select league, abbreviation, {{ norm_name('name', keep_suffix=true) }} from {{ ref('team_reference') }}
        union
        select league, abbreviation, lower(abbreviation) from {{ ref('team_reference') }}
        union
        select league, abbreviation, 'la' || {{ norm_name('name', keep_suffix=true) }}
        from {{ ref('team_reference') }}
        where city = 'Los Angeles'
    ) as labels
    qualify count(*) over (partition by league, label) = 1

),

page_games as (

    select
        p.league,
        s.season,
        s.game_id,
        s.game_date_est as game_date,
        p.crew_chief,
        p.crew_chief_number,
        p.referee,
        p.referee_number,
        p.umpire,
        p.umpire_number,
        p.alternate,
        p.alternate_number,
        p._ingest_date
    from pages as p
    join team_names as ta
        on ta.league = p.league and ta.label = {{ norm_name('p.away_team', keep_suffix=true) }}
    join team_names as th
        on th.league = p.league and th.label = {{ norm_name('p.home_team', keep_suffix=true) }}
    join {{ ref('schedule') }} as s
        on s.league = p.league
        and s.game_date_est = cast(p.page_date as date)
        and s.away_team_tricode = ta.abbreviation
        and s.home_team_tricode = th.abbreviation

),

page_officials as (

    select league, season, game_id, game_date, 'crew_chief' as role, crew_chief as official_name, crew_chief_number as uniform_number, _ingest_date from page_games
    union all
    select league, season, game_id, game_date, 'referee', referee, referee_number, _ingest_date from page_games
    union all
    select league, season, game_id, game_date, 'umpire', umpire, umpire_number, _ingest_date from page_games
    union all
    select league, season, game_id, game_date, 'alternate', alternate, alternate_number, _ingest_date from page_games

),

page as (

    select
        league,
        season,
        game_id,
        game_date,
        role,
        {{ norm_name('official_name', keep_suffix=true) }} as official_key,
        official_name,
        try_cast(uniform_number as integer) as uniform_number,
        _ingest_date
    from page_officials
    where official_name is not null
    qualify row_number() over (
        partition by league, game_id, {{ norm_name('official_name', keep_suffix=true) }}
        order by case role when 'crew_chief' then 1 when 'referee' then 2 when 'umpire' then 3 else 4 end
    ) = 1

),

espn_games as (

    select distinct league, game_id from espn

)

select
    e.league || ':' || e.game_id || ':' || e.official_key as game_official_key,
    e.league,
    e.season,
    e.game_id,
    e.game_date,
    e.official_key,
    coalesce(p.official_name, e.official_name) as official_name,
    p.role,
    p.uniform_number,
    e.listed_order,
    case when p.official_key is null then 'espn' else 'both' end as source,
    e._ingest_date
from espn as e
left join page as p
    on p.league = e.league and p.game_id = e.game_id and p.official_key = e.official_key

union all

select
    p.league || ':' || p.game_id || ':' || p.official_key as game_official_key,
    p.league,
    p.season,
    p.game_id,
    p.game_date,
    p.official_key,
    p.official_name,
    p.role,
    p.uniform_number,
    cast(null as integer) as listed_order,
    'assignments' as source,
    p._ingest_date
from page as p
left join espn_games as eg on eg.league = p.league and eg.game_id = p.game_id
where eg.game_id is null
