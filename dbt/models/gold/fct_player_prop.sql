{#
  The prop line each bookmaker last set before tip-off, per player, game, market, source and
  bookmaker, linked to the league's player and game ids, with the consensus of the bookmakers
  beside it. Private (ADR 0008): it goes out only in the owner's Parquet, never in the public JSON
  or on a page. It is a model input and an analysis aid (notebooks/06_prop_lines), not a pick.

  - The latest pre-game snapshot: the last run of the reports ingest before the game's start time.
    A quote that is not linked to both a league player and a league game is left out (silver
    player_props keeps it).
  - Consensus: the mean line, and the mean over probability with the vig removed, across the
    bookmakers quoting the player's market for the game, each bookmaker counted once. DraftKings
    comes from both sources; the later snapshot counts, and The Odds API's on a tie.
#}

with pre_game as (

    select *
    from {{ ref('player_props') }}
    where is_pre_game and game_id is not null and player_id is not null

),

latest as (

    select *
    from pre_game
    qualify row_number() over (
        partition by league, game_id, player_id, market, source, bookmaker
        order by snapshot_at desc, line_updated_at desc, player_prop_key
    ) = 1

),

per_book as (

    select *
    from latest
    qualify row_number() over (
        partition by league, game_id, player_id, market, bookmaker
        order by snapshot_at desc, case when source = 'odds_api' then 0 else 1 end
    ) = 1

),

consensus as (

    select
        league,
        game_id,
        player_id,
        market,
        avg(line) as consensus_line,
        avg(over_prob_no_vig) as consensus_over_prob_no_vig,
        count(*) as books_quoting
    from per_book
    group by league, game_id, player_id, market

)

select
    {{ sk(['l.league', 'l.game_id', 'l.player_id', 'l.market', 'l.source', 'l.bookmaker']) }} as player_prop_sk,
    l.league,
    l.season,
    l.game_id,
    l.game_date,
    l.commence_at,
    l.player_id,
    l.player_link,
    l.market,
    l.source,
    l.bookmaker,
    l.line,
    l.open_line,
    l.over_price,
    l.under_price,
    l.over_prob_no_vig,
    l.vig,
    l.snapshot_key,
    l.snapshot_at,
    l.line_updated_at,
    c.consensus_line,
    c.consensus_over_prob_no_vig,
    c.books_quoting
from latest as l
join consensus as c
    on c.league = l.league and c.game_id = l.game_id and c.player_id = l.player_id and c.market = l.market
