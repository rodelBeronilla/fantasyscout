{#
  Every official injury listing before a regular-season game, with what followed: one row per
  league, game and listed player. It is the history the availability calibration averages.

  - The listing is the last report the league published by 5 pm Eastern on the game's date (the
    history backfill lands the 5 pm report; the daily runs land a morning and an evening report,
    and the evening one is after many tip-offs, so it is left out).
  - The game is found by its date and the listed team; the player by name within that team's
    season roster or game log (a name two players of the team share is left unlinked).
  - games_missed counts the team's regular-season games from this one until the player's next
    played regular-season game, or to the end of the team's season when there is none.
  - played: whether the player played the listed game.
#}

with team_names as (

    select league, team_id, lower(replace(team_name, ' ', '')) as team_key
    from {{ ref('teams') }}
    qualify row_number() over (partition by league, team_id order by season desc) = 1

),

reports as (

    select o.*, t.team_id
    from {{ ref('official_injury_report') }} as o
    join team_names as t on t.league = o.league and t.team_key = lower(replace(o.team, ' ', ''))
    where not o.not_submitted
        and o.player_name is not null
        and o.status is not null
        and cast(o.published_at_et as date) = o.game_date
        and hour(o.published_at_et) <= 17

),

last_listing as (

    select *
    from reports
    qualify row_number() over (
        partition by league, game_date, team_id, player_name order by published_at_et desc
    ) = 1

),

team_games as (

    -- each team's played regular-season games
    select league, season, game_id, game_date, team_id
    from {{ ref('fct_team_game') }}
    where substr(game_id, 3, 1) = '2'

),

season_names as (

    select distinct league, season, team_id, player_id, {{ norm_name('player_name') }} as name_key
    from (
        select r.league, r.season, r.team_id, r.player_id, r.player_name
        from {{ ref('rosters') }} as r
        union all
        select g.league, g.season, g.team_id, g.player_id, p.full_name as player_name
        from (select distinct league, season, team_id, player_id from {{ ref('fct_player_game') }}) as g
        join (
            select league, stats_player_id, max(full_name) as full_name
            from {{ ref('dim_player') }}
            group by league, stats_player_id
        ) as p on p.league = g.league and p.stats_player_id = g.player_id
    ) as named
    where player_name is not null

),

unique_names as (

    select league, season, team_id, name_key, min(player_id) as player_id
    from season_names
    group by league, season, team_id, name_key
    having count(distinct player_id) = 1

),

linked as (

    select
        l.league,
        g.season,
        g.game_id,
        l.game_date,
        l.team_id,
        n.player_id,
        l.status,
        l.reason_group,
        l.injury_detail,
        l.published_at_et
    from last_listing as l
    join team_games as g on g.league = l.league and g.team_id = l.team_id and g.game_date = l.game_date
    join unique_names as n
        on n.league = l.league and n.season = g.season and n.team_id = l.team_id
        and n.name_key = {{ norm_name('l.player_name') }}

),

next_played as (

    select k.league, k.game_id, k.player_id, min(p.game_date) as next_played_date
    from linked as k
    join {{ ref('fct_player_game') }} as p
        on p.league = k.league and p.player_id = k.player_id and p.season = k.season
        and p.played and substr(p.game_id, 3, 1) = '2' and p.game_date >= k.game_date
    group by k.league, k.game_id, k.player_id

),

spells as (

    select
        k.league,
        k.game_id,
        k.player_id,
        cast(sum(case when np.next_played_date is null or g.game_date < np.next_played_date then 1 else 0 end) as integer) as games_missed,
        cast(count(*) as integer) as team_games_left
    from linked as k
    left join next_played as np on np.league = k.league and np.game_id = k.game_id and np.player_id = k.player_id
    join team_games as g
        on g.league = k.league and g.season = k.season and g.team_id = k.team_id and g.game_date >= k.game_date
    group by k.league, k.game_id, k.player_id

)

select
    {{ sk(['k.league', 'k.game_id', 'k.player_id']) }} as official_listing_sk,
    k.league,
    k.season,
    k.game_id,
    k.game_date,
    k.team_id,
    k.player_id,
    k.status,
    k.reason_group,
    k.injury_detail,
    k.published_at_et as report_at,
    coalesce(pg.played, false) as played,
    s.games_missed,
    s.team_games_left
from linked as k
join spells as s on s.league = k.league and s.game_id = k.game_id and s.player_id = k.player_id
left join {{ ref('fct_player_game') }} as pg
    on pg.league = k.league and pg.game_id = k.game_id and pg.player_id = k.player_id
qualify row_number() over (partition by k.league, k.game_id, k.player_id order by k.published_at_et desc) = 1
