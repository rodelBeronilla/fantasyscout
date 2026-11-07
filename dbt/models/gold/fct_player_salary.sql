{#
  Each NBA player's salary per season (#772), from the team payrolls Basketball-Reference
  publishes (bronze.bref_salaries; the terms are ADR 0008's addendum of 2026-11-07). One row per
  player, season and team page: a player traded mid-season is on both teams' payrolls.

  The stats player id is found by name among the players of that league-season (rosters and game
  logs), as fct_official_listing finds a listed player; a name two players share that season is
  left unlinked. A blank salary (a player on a ten-day or two-way deal) stays null.
#}

with landed as (

    select *
    from {{ ref('bref_salaries') }}
    where bref_player_id is not null
    qualify row_number() over (
        partition by league, season, bref_team, bref_player_id order by _ingest_date desc, _source_file desc
    ) = 1

),

season_names as (

    select distinct league, season, player_id, {{ norm_name('player_name') }} as name_key
    from (
        select league, season, player_id, player_name from {{ ref('rosters') }}
        union all
        select g.league, g.season, g.player_id, p.full_name as player_name
        from (select distinct league, season, player_id from {{ ref('fct_player_game') }}) as g
        join (
            select league, stats_player_id, max(full_name) as full_name
            from {{ ref('dim_player') }}
            group by league, stats_player_id
        ) as p on p.league = g.league and p.stats_player_id = g.player_id
    ) as named
    where player_name is not null

),

unique_names as (

    select league, season, name_key, min(player_id) as player_id
    from season_names
    group by league, season, name_key
    having count(distinct player_id) = 1

)

select
    l.league || ':' || l.season || ':' || l.bref_team || ':' || l.bref_player_id as player_salary_sk,
    l.league,
    l.season,
    l.bref_team,
    l.bref_player_id,
    l.player_name,
    n.player_id,
    try_cast(l.salary as bigint) as salary
from landed as l
left join unique_names as n
    on n.league = l.league and n.season = l.season and n.name_key = {{ norm_name('l.player_name') }}
