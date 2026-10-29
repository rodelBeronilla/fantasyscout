{#
  One projected per-game line per player on a current roster: what the board scores.

  Inputs are each player's per-game lines in the league's current season and the two before
  it. Each season counts by games played times a recency weight (var fantasy_recency: 1.0,
  0.25, 0.08, chosen by backtest, ADR 0003), and every projection also starts from
  prior_games games of a replacement-level line (var fantasy: 3 NBA, 5 WNBA). So a three-game sample moves a
  projection only part of the way, a full season moves it most of the way, and a missing
  season simply adds nothing; nothing hands its weight to anything else.

  The replacement-level line is the average per-game line of the players just outside a
  fantasy league's rosters by total minutes (ranks pool_size + 1 to pool_size + teams) in the
  league's latest complete regular season.

  Current roster: the player is on their team's latest roster landing for the league's latest
  roster season. A player waived or released drops off with the next landing, and a retired
  player is on no roster at all, so neither is projected. Only players with at least one game
  in the three seasons are projected.
#}

{% set stats = ['minutes', 'points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'fgm', 'fga', 'ftm', 'fta'] %}

with seasons as (

    select
        league,
        season,
        player_id,
        games,
        dense_rank() over (partition by league order by season desc) as season_rank,
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
    from {{ ref('mart_category_zscores') }}
    where window_name = 'season'

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
        {%- for s in stats %}
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

    select league, season, team_id, player_id, _ingest_date
    from {{ ref('rosters') }}
    qualify season = max(season) over (partition by league)
        and _ingest_date = max(_ingest_date) over (partition by league, season, team_id)

),

current_roster as (

    -- A player on two teams' latest landings (traded between them) belongs to the newer one.
    select league, season as roster_season, team_id, player_id
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
        sum(case when season_rank = 1 then {{ fantasy_recency('season_rank') }} * games else 0 end) as weight_cur,
        sum(case when season_rank = 2 then {{ fantasy_recency('season_rank') }} * games else 0 end) as weight_prev,
        sum(case when season_rank = 3 then {{ fantasy_recency('season_rank') }} * games else 0 end) as weight_prev2,
        {%- for s in stats %}
        sum({{ fantasy_recency('season_rank') }} * games * coalesce({{ s }}_pg, 0)) as wsum_{{ s }}{{ "," if not loop.last }}
        {%- endfor %}
    from seasons
    where season_rank <= 3
    group by league, player_id
    having sum(games) > 0

),

projected as (

    select
        w.league,
        cs.season,
        w.player_id,
        cr.team_id,
        cr.roster_season,
        w.games_current,
        w.games_prev,
        w.games_prev2,
        w.weight_cur + w.weight_prev + w.weight_prev2 as sample_weight,
        {{ fantasy_setting('prior_games', 'w.league') }} as prior_games,
        w.weight_cur / (w.weight_cur + w.weight_prev + w.weight_prev2 + {{ fantasy_setting('prior_games', 'w.league') }}) as w_cur,
        w.weight_prev / (w.weight_cur + w.weight_prev + w.weight_prev2 + {{ fantasy_setting('prior_games', 'w.league') }}) as w_prev,
        w.weight_prev2 / (w.weight_cur + w.weight_prev + w.weight_prev2 + {{ fantasy_setting('prior_games', 'w.league') }}) as w_prev2,
        {{ fantasy_setting('prior_games', 'w.league') }}
            / (w.weight_cur + w.weight_prev + w.weight_prev2 + {{ fantasy_setting('prior_games', 'w.league') }}) as w_prior,
        {%- for s in stats %}
        (w.wsum_{{ s }} + {{ fantasy_setting('prior_games', 'w.league') }} * coalesce(rl.prior_{{ s }}_pg, 0))
            / (w.weight_cur + w.weight_prev + w.weight_prev2 + {{ fantasy_setting('prior_games', 'w.league') }}) as proj_{{ s }}_pg{{ "," if not loop.last }}
        {%- endfor %}
    from weighted as w
    join current_roster as cr on cr.league = w.league and cr.player_id = w.player_id
    join current_season as cs on cs.league = w.league
    left join replacement_line as rl on rl.league = w.league

)

select
    {{ sk(['league', 'player_id']) }} as projection_sk,
    league,
    season,
    player_id,
    team_id,
    roster_season,
    games_current,
    games_prev,
    games_prev2,
    sample_weight,
    prior_games,
    w_cur,
    w_prev,
    w_prev2,
    w_prior,
    proj_minutes_pg,
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
from projected
