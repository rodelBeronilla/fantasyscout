{{ config(severity='error', tags=['quality', 'board']) }}

-- One value scale (#767, ADR 0019). Fails on any of:
--   game_mean     a player's mean regular-season game value is not their season z_total (the scale
--                 is linear in a game's numbers, so the two are the same figure)
--   replacement   the board's replacement band (the `teams` players after the pool, by value) does
--                 not average zero: value is above replacement level
--   playoff_game  a playoff or play-in game is valued (fantasy windows are the regular season)
with game_mean as (

    select g.league, g.season, g.player_id, avg(g.game_value) as game_mean, max(z.z_total) as season_value
    from {{ ref('int_player_game_value') }} as g
    join {{ ref('mart_category_zscores') }} as z
        on z.league = g.league and z.season = g.season and z.player_id = g.player_id and z.window_name = 'season'
    group by g.league, g.season, g.player_id

),

board_band as (

    select b.league, avg(b.z_total) as band_value
    from (
        select league, season, z_total, row_number() over (partition by league order by z_total desc, player_id) as value_rank
        from {{ ref('mart_board') }}
    ) as b
    join {{ ref('int_value_scale') }} as s on s.league = b.league and s.season = b.season
    where b.value_rank > s.pool and b.value_rank <= s.pool + s.teams
    group by b.league

)

select 'game_mean' as failure, league, player_id, game_mean - season_value as gap
from game_mean
where abs(game_mean - season_value) > 0.000001

union all

select 'replacement' as failure, league, null as player_id, band_value as gap
from board_band
where abs(band_value) > 0.000001

union all

select 'playoff_game' as failure, league, player_id, null as gap
from {{ ref('int_player_game_value') }}
where not {{ is_regular_season('game_id') }}
