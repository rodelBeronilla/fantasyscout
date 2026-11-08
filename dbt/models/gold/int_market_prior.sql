{#
  The market's draft order for the season being played (#832): the input of the board's market
  prior (the market_prior var, mart_board). One row per league and player with an ESPN draft
  position that season (silver.espn_preseason_adp through the id crosswalk), with his rank by it
  and his regular-season games so far that season, which fade the prior.

  The season is the one under way: from the day before its first regular-season game, when its
  draft order is known, through its last. Between seasons there is none, so a past season's draft
  order is never read as this one's, and a season whose draft order was never landed has no rows.
#}

with draft_season as (

    select league, season
    from {{ ref('schedule') }}
    where game_type = 'regular'
    group by league, season
    having {{ add_days('min(game_date_est)', -1) }} <= {{ as_of_date() }}
        and max(game_date_est) >= {{ as_of_date() }}

),

picks as (

    select a.league, a.season, x.stats_player_id as player_id, min(a.adp_rank) as adp_rank
    from {{ ref('espn_preseason_adp') }} as a
    join draft_season as d on d.league = a.league and d.season = a.season
    join {{ ref('player_xwalk') }} as x on x.league = a.league and x.espn_player_id = a.espn_player_id
    group by a.league, a.season, x.stats_player_id

),

games as (

    -- regular-season games played: the third character of a league game id is 2
    select g.league, g.player_id, count(*) as games
    from {{ ref('fct_player_game') }} as g
    join draft_season as d on d.league = g.league and d.season = g.season
    where g.played and substr(g.game_id, 3, 1) = '2'
    group by g.league, g.player_id

)

select
    p.league || ':' || p.player_id as market_prior_key,
    p.league,
    p.season,
    p.player_id,
    p.adp_rank,
    cast(coalesce(g.games, 0) as integer) as games
from picks as p
left join games as g on g.league = p.league and g.player_id = p.player_id
