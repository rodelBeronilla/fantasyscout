{#
  Absence spells from the box scores alone (#798, for #770): one row per run of regular-season games
  a regular missed, where no official report says why. They fill the seasons without official
  reports (the WNBA before 2026, the NBA before 2018-12-17) and stand beside fct_injury_spell.

  - A regular: played his team's previous regular-season game and averaged at least
    absence_spells.min_minutes over his last absence_spells.recent_games games played. A game such
    a player then misses starts a spell, which runs to his next regular-season game played, for
    any team; a spell that ends with a game for another team was a trade, not an absence, and is
    left out. A spell can start only after a game played, so one running from the season's first
    game is missed. A regular rarely sits by the coach's choice, but the box score cannot tell an injury
    from rest, personal leave or a suspension: a spell here has no reason and no body part.
  - Censored as fct_injury_spell is: without a return, ongoing while the team still has
    regular-season games to play, season_end when the season ended first; games_missed and
    days_out are then a lower bound.
#}

{% set cfg = var('absence_spells') %}

with team_games as (

    select
        league,
        season,
        team_id,
        game_id,
        game_date,
        row_number() over (partition by league, season, team_id order by game_date, game_id) as team_game_no
    from {{ ref('fct_team_game') }}
    where {{ is_regular_season('game_id') }}

),

played as (

    select
        g.league,
        g.season,
        g.team_id,
        g.player_id,
        g.game_date,
        tg.team_game_no,
        avg(g.minutes) over (
            partition by g.league, g.season, g.player_id
            order by g.game_date, g.game_id
            rows between {{ cfg['recent_games'] - 1 }} preceding and current row
        ) as recent_minutes,
        lead(g.game_date) over (partition by g.league, g.season, g.player_id order by g.game_date, g.game_id)
            as next_played_date,
        lead(g.team_id) over (partition by g.league, g.season, g.player_id order by g.game_date, g.game_id)
            as next_team_id
    from {{ ref('fct_player_game') }} as g
    join team_games as tg on tg.league = g.league and tg.game_id = g.game_id and tg.team_id = g.team_id
    where g.played and {{ is_regular_season('g.game_id') }}

),

starts as (

    -- a regular's game played, followed by a team game he missed
    select
        p.league,
        p.season,
        p.team_id,
        p.player_id,
        p.recent_minutes,
        p.next_played_date,
        p.next_team_id,
        nxt.game_id as first_game_id,
        nxt.game_date as start_date
    from played as p
    join team_games as nxt
        on nxt.league = p.league and nxt.season = p.season and nxt.team_id = p.team_id
        and nxt.team_game_no = p.team_game_no + 1
    where p.recent_minutes >= {{ cfg['min_minutes'] }}
        and (p.next_played_date is null or p.next_played_date > nxt.game_date)
        -- a player traded away misses his old team's games: not an absence
        and (p.next_team_id is null or p.next_team_id = p.team_id)

),

spells as (

    select
        s.*,
        count(tg.game_id) as games_missed,
        max(tg.game_date) as last_missed_date
    from starts as s
    join team_games as tg
        on tg.league = s.league and tg.season = s.season and tg.team_id = s.team_id
        and tg.game_date >= s.start_date
        and (s.next_played_date is null or tg.game_date < s.next_played_date)
    group by all

),

team_left as (

    select
        league,
        season,
        team_id,
        sum(case when game_type = 'regular' and not {{ is_final('game_status', 'game_date_est') }} then 1 else 0 end) as games_left
    from {{ ref('schedule_team_games') }}
    group by league, season, team_id

)

select
    {{ sk(['s.league', 's.player_id', 's.first_game_id']) }} as absence_spell_sk,
    s.league,
    s.season,
    s.player_id,
    s.team_id,
    s.first_game_id,
    s.start_date,
    s.next_played_date as return_date,
    s.next_played_date is not null as returned,
    case
        when s.next_played_date is not null then null
        when coalesce(tl.games_left, 0) > 0 then 'ongoing'
        else 'season_end'
    end as censored,
    cast(s.games_missed as integer) as games_missed,
    cast({{ days_between('s.start_date', 'coalesce(s.next_played_date, s.last_missed_date)') }} as integer) as days_out,
    s.recent_minutes as minutes_before
from spells as s
left join team_left as tl on tl.league = s.league and tl.season = s.season and tl.team_id = s.team_id
