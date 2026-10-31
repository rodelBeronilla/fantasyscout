{#
  One projected line per player on a current roster: what the board scores.

  The projection separates how much a player plays from what they do while playing:

  - Minutes per game: each season's minutes per game counted by games played times a minutes
    recency weight (per league, var fantasy.<league>.minutes_recency), so a change of role in
    the current season shows within a few games where the league's roles move a lot (WNBA). A
    past season spent mostly on another team counts for var fantasy_team_change (0.25) of its
    minutes weight: the role was a different team's. Per-minute production carries over.
    In season, with five or more games for the current team, the figure is blended with the player's
    last five games at var fantasy_recent_minutes (0.5), so a role change shows at once.
  - Return ramp: in season, for a player with five or more games this season who is still out, or
    just back, after three or more straight games of the current team missed, minutes per game
    are cut by 1% per game of that absence (at most 50%) while the player is out, half that after
    the first game back and none from the second (var fantasy_return_ramp). Players come back on
    reduced minutes, and the last five games only show it once they have been played. The team's
    games count from the player's first game for it this season, or from its first game when it
    was their main team last season, so an injury carried over from last season counts.
  - Production per minute: each season's totals over its minutes, counted by minutes played
    times the production recency weight (var fantasy_recency: 1.0, 0.25, 0.08). A season of
    60 games at 8 minutes counts for far less than 60 games at 34.
  - Per-game line: production per minute times projected minutes.
  - Games share (durability): the share of their team's regular-season games a player played
    in the seasons they appeared in, by the same recency, regressed toward a typical share by
    durability_games games (var fantasy.<league>.durability_games, fantasy_durability).
    Regular season only: playoff games would make every team that missed the playoffs look
    as if its players sat out.

  Every projection also starts from prior_games games of a replacement-level player (var
  fantasy: 3 NBA, 5 WNBA), at that player's minutes and per-minute production, so a short
  sample moves a projection only part of the way and a missing season adds nothing. All
  settings were chosen by backtest (ADR 0003).

  The replacement-level line is the average line of the players just outside a fantasy
  league's rosters by total minutes (ranks pool_size + 1 to pool_size + teams) in the
  league's latest complete regular season.

  Current roster: the player is on their team's latest roster landing for the league's latest
  roster season. A player waived or released drops off with the next landing, and a retired
  player is on no roster at all, so neither is projected. Only players with at least one game
  in the three seasons are projected.
#}

{# minutes per game, season-weighted, from a replacement-level prior #}
{%- set base_minutes -%}
((w.minutes_weighted + {{ fantasy_setting('prior_games', 'w.league') }} * rl.prior_minutes_pg)
            / (w.minutes_games_weight + {{ fantasy_setting('prior_games', 'w.league') }}))
{%- endset %}

{% set production = ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'fgm', 'fga', 'ftm', 'fta'] %}
{% set durability = var('fantasy_durability') %}
{% set ramp = var('fantasy_return_ramp') %}

{# the share of projected minutes kept after an absence (fantasy_return_ramp; ADR 0003) #}
{%- set return_factor -%}
case
            when coalesce(ins.in_season, false) and w.games_current >= 5 and la.absence_games is not null
                then 1 - least({{ ramp['max_cut'] }}, {{ ramp['per_game_missed'] }} * la.absence_games)
                    * greatest(0.0, 1 - cast(la.games_since_return as double) / {{ ramp['games_back'] }})
            else 1.0
        end
{%- endset %}

with regular_games as (

    -- regular-season games: the third character of a league game id is 2
    select league, season, player_id, count(*) as games_regular
    from {{ ref('fct_player_game') }}
    where played and substr(game_id, 3, 1) = '2'
    group by league, season, player_id

),

team_regular_games as (

    -- a team's regular-season games, the most any team has played (the current season so far)
    select league, season, max(games) as team_games
    from (
        select league, season, team_id, count(distinct game_id) as games
        from {{ ref('fct_player_game') }}
        where substr(game_id, 3, 1) = '2'
        group by league, season, team_id
    ) as per_team
    group by league, season

),

season_team as (

    -- the team a player played most games for in each season
    select league, season, player_id, team_id
    from (
        select league, season, player_id, team_id, count(*) as games
        from {{ ref('fct_player_game') }}
        where played
        group by league, season, player_id, team_id
    ) as per_team
    qualify row_number() over (partition by league, season, player_id order by games desc, team_id) = 1

),

seasons as (

    select
        z.league,
        z.season,
        z.player_id,
        z.games,
        dense_rank() over (partition by z.league order by z.season desc) as season_rank,
        coalesce(rg.games_regular, 0) as games_regular,
        tg.team_games,
        minutes_pg,
        points_pg,
        rebounds_total_pg,
        assists_pg,
        steals_pg,
        blocks_pg,
        three_pointers_made_pg,
        turnovers_pg,
        coalesce(field_goal_pct, 0) * fga_pg as fgm_pg,
        fga_pg,
        coalesce(free_throw_pct, 0) * fta_pg as ftm_pg,
        fta_pg
    from {{ ref('mart_category_zscores') }} as z
    left join regular_games as rg on rg.league = z.league and rg.season = z.season and rg.player_id = z.player_id
    left join team_regular_games as tg on tg.league = z.league and tg.season = z.season
    where z.window_name = 'season'

),

current_season as (

    select league, max(season) as season from seasons group by league

),

regular_seasons as (

    select league, season, sum(case when game_status <> 3 then 1 else 0 end) as games_left, count(*) as games
    from {{ ref('schedule') }}
    where game_type = 'regular'
    group by league, season

),

reference_season as (

    -- The latest complete regular season; failing one, the season before the current one.
    select cs.league, coalesce(max(rs.season), max(prev.season)) as season
    from current_season as cs
    left join regular_seasons as rs
        on rs.league = cs.league and rs.games_left = 0 and rs.games > 0
    left join seasons as prev
        on prev.league = cs.league and prev.season_rank = 2
    group by cs.league

),

replacement_line as (

    select
        league,
        avg(minutes_pg) as prior_minutes_pg,
        {%- for s in production %}
        avg({{ s }}_pg) as prior_{{ s }}_pg{{ "," if not loop.last }}
        {%- endfor %}
    from (
        select
            z.*,
            row_number() over (partition by z.league order by z.games * z.minutes_pg desc, z.player_id) as minutes_rank
        from seasons as z
        join reference_season as r on r.league = z.league and r.season = z.season
    ) as ranked
    where minutes_rank > {{ fantasy_setting('pool_size') }}
        and minutes_rank <= {{ fantasy_setting('pool_size') }} + {{ fantasy_setting('teams') }}
    group by league

),

latest_landing as (

    select league, season, team_id, player_id, age, experience, _ingest_date
    from {{ ref('rosters') }}
    qualify season = max(season) over (partition by league)
        and _ingest_date = max(_ingest_date) over (partition by league, season, team_id)

),

current_roster as (

    -- A player on two teams' latest landings (traded between them) belongs to the newer one.
    select league, season as roster_season, team_id, player_id, age,
        -- the league lists a rookie's experience as R
        upper(trim(experience)) = 'R' as is_rookie
    from latest_landing
    qualify row_number() over (partition by league, player_id order by _ingest_date desc, team_id) = 1

),

weighted as (

    select
        league,
        player_id,
        cast(sum(case when season_rank = 1 then games else 0 end) as integer) as games_current,
        cast(sum(case when season_rank = 2 then games else 0 end) as integer) as games_prev,
        cast(sum(case when season_rank = 3 then games else 0 end) as integer) as games_prev2,
        sum(case when season_rank = 1 then games * minutes_pg else 0 end) as minutes_current,
        sum(case when season_rank = 2 then games * minutes_pg else 0 end) as minutes_prev,
        sum(case when season_rank = 3 then games * minutes_pg else 0 end) as minutes_prev2,
        -- games by production recency (sample size), and regular-season games against the
        -- team's for durability, over the seasons the player appeared in the regular season
        sum({{ fantasy_recency('season_rank') }} * games) as sample_weight,
        sum({{ fantasy_recency('season_rank') }} * games_regular) as regular_games_weight,
        sum(case when games_regular > 0 then {{ fantasy_recency('season_rank') }} * team_games else 0 end) as team_games_weight,
        -- minutes per game: games by minutes recency
        sum({{ fantasy_minutes_recency('season_rank') }} * role_factor * games) as minutes_games_weight,
        sum({{ fantasy_minutes_recency('season_rank') }} * role_factor * games * coalesce(minutes_pg, 0)) as minutes_weighted,
        -- production per minute: minutes by production recency
        sum(case when season_rank = 1 then {{ fantasy_recency('season_rank') }} * games * coalesce(minutes_pg, 0) else 0 end) as rate_weight_cur,
        sum(case when season_rank = 2 then {{ fantasy_recency('season_rank') }} * games * coalesce(minutes_pg, 0) else 0 end) as rate_weight_prev,
        sum(case when season_rank = 3 then {{ fantasy_recency('season_rank') }} * games * coalesce(minutes_pg, 0) else 0 end) as rate_weight_prev2,
        {%- for s in production %}
        sum({{ fantasy_recency('season_rank') }} * games * coalesce({{ s }}_pg, 0)) as wsum_{{ s }},
        {%- endfor %}
        -- the latest earlier season's team, for the new-team flag
        max(case when season_rank = prev_rank then season_team_id end) as prev_team_id
    from (
        select
            z.*,
            st.team_id as season_team_id,
            -- a past season on another team says less about the current role: its minutes count
            -- for fantasy_team_change (0.25) of their weight; per-minute production carries over
            case
                when z.season_rank > 1 and st.team_id is not null and st.team_id <> cr.team_id then {{ var('fantasy_team_change') }}
                else 1.0
            end as role_factor,
            min(case when z.season_rank > 1 and z.games > 0 then z.season_rank end) over (partition by z.league, z.player_id) as prev_rank
        from seasons as z
        join current_roster as cr on cr.league = z.league and cr.player_id = z.player_id
        left join season_team as st on st.league = z.league and st.season = z.season and st.player_id = z.player_id
    ) as with_team
    where season_rank <= 3 and games > 0
    group by league, player_id

),

-- The last five games the player played this season for the current team, for the in-season minutes.
recent_minutes as (

    select league, player_id, avg(minutes) as recent_minutes_pg, count(*) as recent_games
    from (
        select g.league, g.player_id, g.minutes,
            row_number() over (partition by g.league, g.player_id order by g.game_date desc, g.game_id desc) as rn
        from {{ ref('fct_player_game') }} as g
        join current_season as cs on cs.league = g.league and cs.season = g.season
        join current_roster as cr on cr.league = g.league and cr.player_id = g.player_id and cr.team_id = g.team_id
        where g.played and g.minutes > 0
    ) as recent
    where rn <= 5
    group by league, player_id

),

-- The return ramp's absences: the current team's games this season, in order, each played or not
-- by the player. A run of games missed shares the count of games played before it.
current_team_games as (

    select g.league, g.team_id, g.game_id, min(g.game_date) as game_date
    from {{ ref('fct_player_game') }} as g
    join current_season as cs on cs.league = g.league and cs.season = g.season
    group by g.league, g.team_id, g.game_id

),

last_season_team as (

    -- the player's main team in the season before the current one
    select st.league, st.player_id, st.team_id
    from season_team as st
    join (select distinct league, season from seasons where season_rank = 2) as s2
        on s2.league = st.league and s2.season = st.season

),

team_game_slots as (

    select cr.league, cr.player_id, cr.team_id, tg.game_id, tg.game_date, p.game_id is not null as played
    from current_roster as cr
    join current_team_games as tg on tg.league = cr.league and tg.team_id = cr.team_id
    left join (
        select distinct g.league, g.player_id, g.team_id, g.game_id
        from {{ ref('fct_player_game') }} as g
        join current_season as cs on cs.league = g.league and cs.season = g.season
        where g.played and g.minutes > 0
    ) as p
        on p.league = cr.league and p.player_id = cr.player_id and p.team_id = cr.team_id and p.game_id = tg.game_id

),

team_game_runs as (

    select
        s.*,
        sum(case when s.played then 1 else 0 end) over (
            partition by s.league, s.player_id order by s.game_date, s.game_id
            rows between unbounded preceding and current row
        ) as played_before
    from team_game_slots as s

),

absence_runs as (

    -- runs of fantasy_return_ramp.min_games_missed or more, from the player's first game for the
    -- team this season, or from the team's first game when it was their main team last season
    select r.league, r.player_id, r.played_before, count(*) as absence_games
    from team_game_runs as r
    left join last_season_team as l on l.league = r.league and l.player_id = r.player_id
    where not r.played and (r.played_before > 0 or l.team_id = r.team_id)
    group by r.league, r.player_id, r.played_before
    having count(*) >= {{ ramp['min_games_missed'] }}

),

latest_absence as (

    -- the latest such run, and the player's games for the team since it (0: still out)
    select a.league, a.player_id, a.absence_games, t.games_played - a.played_before as games_since_return
    from absence_runs as a
    join (
        select league, player_id, sum(case when played then 1 else 0 end) as games_played
        from team_game_slots
        group by league, player_id
    ) as t on t.league = a.league and t.player_id = a.player_id
    qualify row_number() over (partition by a.league, a.player_id order by a.played_before desc) = 1

),

-- A league is in season while its current season has regular-season games to play.
in_season as (

    select s.league, true as in_season
    from {{ ref('schedule') }} as s
    join current_season as cs on cs.league = s.league and cs.season = s.season
    where s.game_type = 'regular' and s.game_status <> 3 and s.game_date_est >= {{ as_of_date() }}
    group by s.league

),

projected as (

    select
        w.*,
        cs.season,
        cr.team_id,
        cr.roster_season,
        cr.age,
        cr.is_rookie,
        {{ fantasy_setting('prior_games', 'w.league') }} as prior_games,
        -- the prior's minutes: prior_games games of a replacement-level player
        {{ fantasy_setting('prior_games', 'w.league') }} * rl.prior_minutes_pg as prior_minutes,
        -- minutes per game: the season-weighted figure, and in season (5+ games for the current
        -- team) blended with the last five games at fantasy_recent_minutes, then cut after an
        -- absence by the return ramp (ADR 0003)
        case
            when coalesce(ins.in_season, false) and rm.recent_games >= 5
                then (1 - {{ var('fantasy_recent_minutes') }}) * {{ base_minutes }} + {{ var('fantasy_recent_minutes') }} * rm.recent_minutes_pg
            else {{ base_minutes }}
        end * {{ return_factor }} as proj_minutes_pg,
        {{ base_minutes }} as proj_minutes_season_pg,
        rm.recent_minutes_pg as minutes_last5_pg,
        la.absence_games,
        la.games_since_return,
        {{ return_factor }} as return_minutes_factor,
        least(1.0, (w.regular_games_weight + {{ fantasy_setting('durability_games', 'w.league') }} * {{ durability['typical_share'] }})
            / (w.team_games_weight + {{ fantasy_setting('durability_games', 'w.league') }})) as games_share,
        {%- for s in production %}
        rl.prior_{{ s }}_pg{{ "," if not loop.last }}
        {%- endfor %}
    from weighted as w
    join current_roster as cr on cr.league = w.league and cr.player_id = w.player_id
    join current_season as cs on cs.league = w.league
    join replacement_line as rl on rl.league = w.league
    left join recent_minutes as rm on rm.league = w.league and rm.player_id = w.player_id
    left join latest_absence as la on la.league = w.league and la.player_id = w.player_id
    left join in_season as ins on ins.league = w.league

),

rated as (

    select
        *,
        rate_weight_cur + rate_weight_prev + rate_weight_prev2 + prior_minutes as rate_weight,
        {%- for s in production %}
        -- per minute: weighted totals plus the prior's totals, over weighted minutes plus the prior's minutes
        (wsum_{{ s }} + prior_games * prior_{{ s }}_pg)
            / nullif(rate_weight_cur + rate_weight_prev + rate_weight_prev2 + prior_minutes, 0) * proj_minutes_pg as proj_{{ s }}_pg{{ "," if not loop.last }}
        {%- endfor %}
    from projected

)

select
    {{ sk(['league', 'player_id']) }} as projection_sk,
    league,
    season,
    player_id,
    team_id,
    roster_season,
    age,
    is_rookie,
    prev_team_id,
    coalesce(prev_team_id <> team_id, false) as is_new_team,
    games_current,
    games_prev,
    games_prev2,
    minutes_current,
    minutes_prev,
    minutes_prev2,
    sample_weight,
    prior_games,
    rate_weight_cur / rate_weight as w_cur,
    rate_weight_prev / rate_weight as w_prev,
    rate_weight_prev2 / rate_weight as w_prev2,
    prior_minutes / rate_weight as w_prior,
    games_share,
    proj_minutes_pg,
    proj_minutes_season_pg,
    minutes_last5_pg,
    cast(absence_games as integer) as absence_games,
    cast(games_since_return as integer) as games_since_return,
    return_minutes_factor,
    proj_points_pg,
    proj_rebounds_total_pg,
    proj_assists_pg,
    proj_steals_pg,
    proj_blocks_pg,
    proj_three_pointers_made_pg,
    proj_turnovers_pg,
    proj_fgm_pg,
    proj_fga_pg,
    proj_ftm_pg,
    proj_fta_pg,
    proj_fgm_pg / nullif(proj_fga_pg, 0) as proj_field_goal_pct,
    proj_ftm_pg / nullif(proj_fta_pg, 0) as proj_free_throw_pct
from rated
