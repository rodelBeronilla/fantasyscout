{#
  League stats API team id to ESPN team id, one row per stats team. Matched on the full
  team name first ("Las Vegas Aces" on both sides), then the nickname from the team seed,
  then the abbreviation, which differs between the sources for a handful of teams.
#}

with stats_teams as (

    select
        league,
        team_id as stats_team_id,
        abbreviation,
        team_name,
        name as nickname,
        row_number() over (partition by league, team_id order by season desc) = 1 as is_latest
    from {{ ref('teams') }}

),

latest as (select * from stats_teams where is_latest),

espn as (

    select league, team_id as espn_team_id, abbreviation, display_name, nickname
    from {{ ref('espn_team_directory') }}

),

by_full_name as (

    select s.league, s.stats_team_id, e.espn_team_id, 'full_name' as method, 1 as priority
    from latest as s
    join espn as e
        on e.league = s.league
        and {{ norm_name('e.display_name') }} = {{ norm_name('s.team_name') }}

),

by_nickname as (

    select s.league, s.stats_team_id, e.espn_team_id, 'nickname' as method, 2 as priority
    from latest as s
    join espn as e
        on e.league = s.league
        and s.nickname is not null
        and {{ norm_name('e.nickname') }} = {{ norm_name('s.nickname') }}

),

by_abbreviation as (

    select s.league, s.stats_team_id, e.espn_team_id, 'abbreviation' as method, 3 as priority
    from latest as s
    join espn as e
        on e.league = s.league and e.abbreviation = s.abbreviation

),

candidates as (

    select * from by_full_name
    union all
    select * from by_nickname
    union all
    select * from by_abbreviation

),

ranked as (

    select
        *,
        row_number() over (partition by league, stats_team_id order by priority, espn_team_id) as rk
    from candidates

)

select
    league,
    stats_team_id,
    espn_team_id,
    league || ':' || stats_team_id as team_xwalk_key,
    method
from ranked
where rk = 1
