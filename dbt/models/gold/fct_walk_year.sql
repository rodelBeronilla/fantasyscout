{#
  Who was playing out his contract (#790, for the contract-year study #772): one row per NBA
  player per regular season he played, with whether it was his walk year.

  A season Y was a player's walk year when, between Y's last regular-season game and the next
  season's first, he signed a standard contract, with a new team or re-signing with his own, in
  the league's official movement feed (silver.transactions, source nba). Ten-day, two-way,
  rest-of-season and substitute deals, rookie-scale contracts and extensions do not count: none
  says a contract ran out.

  The flag is hindsight. It rebuilds what was public during Y, an expiring contract, from what
  happened after it. That is right for measuring the effect, and a point-in-time build cannot know
  it inside the season, since its transactions stop at the cut. A live flag would need current
  contract lengths and is built only if the study finds an effect. Noise it does not remove:
  player options, a free agent who signs only after the next season starts, and a player waived
  and re-signed in the offseason.
#}

with seasons as (

    select
        league,
        season,
        min(game_date_est) as first_game,
        max(game_date_est) as last_game,
        lead(min(game_date_est)) over (partition by league order by season) as next_first_game
    from {{ ref('schedule') }}
    where game_type = 'regular'
    group by league, season

),

played as (

    select distinct league, season, player_id
    from {{ ref('fct_player_game') }}
    where played and {{ is_regular_season('game_id') }} and league = 'nba'

),

signings as (

    select
        t.league,
        t.player_id,
        t.transaction_date,
        t.team_id,
        lower(t.description) like '%re-signed%' as re_signed
    from {{ ref('transactions') }} as t
    where t.source = 'nba'
        and t.transaction_type = 'Signing'
        and t.player_id is not null
        -- a standard contract: "... to a Contract."
        and {{ matches('t.description', ' to a Contract[.]?$') }}

),

walked as (

    select
        p.league,
        p.season,
        p.player_id,
        min_by(sg.transaction_date, sg.transaction_date) as signed_on,
        min_by(sg.re_signed, sg.transaction_date) as re_signed,
        min_by(sg.team_id, sg.transaction_date) as signing_team_id
    from played as p
    join seasons as s on s.league = p.league and s.season = p.season
    join signings as sg
        on sg.league = p.league and sg.player_id = p.player_id
        and sg.transaction_date > s.last_game
        and (s.next_first_game is null or sg.transaction_date < s.next_first_game)
    group by p.league, p.season, p.player_id

)

select
    {{ sk(['p.league', 'p.season', 'p.player_id']) }} as walk_year_sk,
    p.league,
    p.season,
    p.player_id,
    w.signed_on is not null as walk_year,
    w.signed_on,
    w.re_signed,
    w.signing_team_id
from played as p
left join walked as w on w.league = p.league and w.season = p.season and w.player_id = p.player_id
