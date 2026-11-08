{#
  Who takes a player's minutes when he misses games (#820): for each team and each rotation player
  on it now, the minutes each current teammate averaged in the team's regular-season games the
  player missed, against the games he played, over this season and last.

  - A player is on a team from his first game listed with it to his last, or to the end of the
    team's season when it is his last team that season (as notebook 07 counts rosters). A team game
    in that span without minutes is a game he missed, whatever the reason.
  - A rotation player averaged minutes_redistribution.rotation_minutes or more in the games he
    played for the team, and has missed and played minutes_redistribution.min_games_missed of its
    games or more.
  - A teammate's minutes count in the games he was there for: those he played, and those the box
    score says the coach sat him (a DNP - Coach's Decision, as 0). A game he missed himself for
    any other reason counts in neither average, so his own injury does not read as a loss.
    Each split needs min_games_missed of his games.
  - Both are on the team now (dim_player's current stint), so the row is about today's roster.
  - A game played on or after a point-in-time build's date is left out (the facts already cut it).

  minutes_gained is minutes_without less minutes_with; gain_rank orders the player's teammates by
  it, largest first. An average, not a model: who started, the opponent and blowouts are not held
  apart (#763 will test it).
#}

{% set cfg = var('minutes_redistribution') %}

with regular_seasons as (

    select distinct league, season
    from {{ ref('fct_team_game') }}
    where {{ is_regular_season('game_id') }}

),

seasons as (

    -- this season and last, per league
    select league, season
    from regular_seasons
    qualify dense_rank() over (partition by league order by season desc) <= 2

),

team_games as (

    select tg.league, tg.season, tg.team_id, tg.game_id, tg.game_date
    from {{ ref('fct_team_game') }} as tg
    join seasons as s on s.league = tg.league and s.season = tg.season
    where {{ is_regular_season('tg.game_id') }}
        and {{ known_before('tg.game_date') }}

),

box as (

    select
        g.league,
        g.season,
        g.team_id,
        g.game_id,
        g.game_date,
        g.player_id,
        coalesce(g.played, false) as played,
        case when coalesce(g.played, false) then g.minutes else 0 end as minutes,
        coalesce(g.played, false) or lower(coalesce(g.comment, '')) like '%coach%' as available
    from {{ ref('fct_player_game') }} as g
    join seasons as s on s.league = g.league and s.season = g.season
    where {{ is_regular_season('g.game_id') }}
        and {{ known_before('g.game_date') }}

),

stint_bounds as (

    select league, season, player_id, team_id, min(game_date) as first_date, max(game_date) as last_date
    from box
    group by league, season, player_id, team_id

),

last_team as (

    -- the player's team in his last game of the season
    select league, season, player_id, team_id
    from box
    qualify row_number() over (partition by league, season, player_id order by game_date desc, game_id desc) = 1

),

team_end as (

    select league, season, team_id, max(game_date) as end_date
    from team_games
    group by league, season, team_id

),

stints as (

    select
        sb.league,
        sb.season,
        sb.player_id,
        sb.team_id,
        sb.first_date,
        case when lt.team_id = sb.team_id then te.end_date else sb.last_date end as end_date
    from stint_bounds as sb
    join team_end as te on te.league = sb.league and te.season = sb.season and te.team_id = sb.team_id
    left join last_team as lt on lt.league = sb.league and lt.season = sb.season and lt.player_id = sb.player_id

),

current_team as (

    select league, stats_player_id as player_id, team_id, full_name
    from {{ ref('dim_player') }}
    where is_current

),

-- every team game a player now on the team was on it for, and what he did in it
on_team as (

    select
        tg.league,
        tg.team_id,
        tg.game_id,
        tg.game_date,
        st.player_id,
        coalesce(b.played, false) as played,
        coalesce(b.minutes, 0) as minutes,
        coalesce(b.available, false) as available
    from team_games as tg
    join stints as st
        on st.league = tg.league and st.season = tg.season and st.team_id = tg.team_id
        and tg.game_date between st.first_date and st.end_date
    join current_team as ct on ct.league = st.league and ct.player_id = st.player_id and ct.team_id = st.team_id
    left join box as b
        on b.league = tg.league and b.game_id = tg.game_id and b.team_id = tg.team_id and b.player_id = st.player_id

),

rotation as (

    select
        league,
        team_id,
        player_id,
        sum(case when played then 1 else 0 end) as games_played,
        sum(case when played then 0 else 1 end) as games_missed,
        avg(case when played then minutes end) as minutes_played
    from on_team
    group by league, team_id, player_id
    having sum(case when played then 0 else 1 end) >= {{ cfg['min_games_missed'] }}
        and sum(case when played then 1 else 0 end) >= {{ cfg['min_games_missed'] }}
        and avg(case when played then minutes end) >= {{ cfg['rotation_minutes'] }}

),

pairs as (

    select
        p.league,
        p.team_id,
        p.player_id,
        q.player_id as teammate_id,
        sum(case when p.played then 1 else 0 end) as teammate_games_with,
        sum(case when p.played then 0 else 1 end) as teammate_games_without,
        avg(case when p.played then q.minutes end) as minutes_with,
        avg(case when p.played then null else q.minutes end) as minutes_without,
        max(p.game_date) as last_game_date
    from on_team as p
    join rotation as r on r.league = p.league and r.team_id = p.team_id and r.player_id = p.player_id
    join on_team as q
        on q.league = p.league and q.team_id = p.team_id and q.game_id = p.game_id
        and q.player_id <> p.player_id and q.available
    group by p.league, p.team_id, p.player_id, q.player_id
    having sum(case when p.played then 1 else 0 end) >= {{ cfg['min_games_missed'] }}
        and sum(case when p.played then 0 else 1 end) >= {{ cfg['min_games_missed'] }}

)

select
    {{ sk(['pr.league', 'pr.team_id', 'pr.player_id', 'pr.teammate_id']) }} as minutes_redistribution_sk,
    pr.league,
    pr.team_id,
    pr.player_id,
    cp.full_name,
    cast(r.games_played as integer) as games_played,
    cast(r.games_missed as integer) as games_missed,
    r.minutes_played,
    pr.teammate_id,
    cq.full_name as teammate_name,
    cast(pr.teammate_games_with as integer) as teammate_games_with,
    cast(pr.teammate_games_without as integer) as teammate_games_without,
    pr.minutes_with,
    pr.minutes_without,
    pr.minutes_without - pr.minutes_with as minutes_gained,
    cast(row_number() over (
        partition by pr.league, pr.team_id, pr.player_id
        order by pr.minutes_without - pr.minutes_with desc, pr.teammate_id
    ) as integer) as gain_rank,
    mk.percent_owned as teammate_percent_owned,
    pr.last_game_date
from pairs as pr
join rotation as r on r.league = pr.league and r.team_id = pr.team_id and r.player_id = pr.player_id
join current_team as cp on cp.league = pr.league and cp.player_id = pr.player_id
join current_team as cq on cq.league = pr.league and cq.player_id = pr.teammate_id
left join {{ ref('fct_market_value') }} as mk on mk.league = pr.league and mk.stats_player_id = pr.teammate_id
