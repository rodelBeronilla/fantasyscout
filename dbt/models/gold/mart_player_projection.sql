{#
  One projected line per player on a current roster: what the board scores.

  The projection separates how much a player plays from what they do while playing. Its parts
  (int_player_projection_parts) are projected minutes, the games share and the weighted sums the
  per-minute rates are made of; see that model for how each is measured. Here:

  - Production per minute: each season's totals over its minutes, counted by minutes played
    times the production recency weight (var fantasy_recency: 1.0, 0.25, 0.08), from prior_games
    games of a replacement-level player (var fantasy: 3 NBA, 5 WNBA).
  - Per-game line: production per minute times projected minutes.

  The advanced-stat features (#771, var projection_features, per league) then adjust the rates.
  Each is off at its neutral value until the walk-forward harness judges it, and on only in the
  leagues where it passed (ops/projection_features.py holds the same formulas in Python):

  - pace: every per-minute counting rate times (pace_target / pace_basis)^pace, where pace_basis is
    the pace of the games the rates were made in (by the production weights, the prior at the
    replacement band's) and pace_target the current team's expected pace.
  - usage_weight: the current season's usage counts usage_weight times its production weight in
    usage_target, against usage_basis at the production weights; the volume categories (points,
    threes, turnovers, shots and free throws) are scaled by usage_target / usage_basis.
  - fg_shrink, ft_shrink: that many attempts at the league's percentage (the reference season's)
    are added to the player's weighted makes and attempts; his attempts are unchanged.
  - other_team_production: a past season spent mostly on another team keeps this share of its
    production weight (minutes already keep fantasy_team_change).

  At the neutral values every expression reduces to the projection without features exactly.
#}

{% set production = ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'fgm', 'fga', 'ftm', 'fta'] %}
{% set volume = ['points', 'three_pointers_made', 'turnovers', 'fgm', 'fga', 'ftm', 'fta'] %}

with parts as (

    select
        *,
        {{ projection_feature('pace') }} as feature_pace,
        {{ projection_feature('usage_weight') }} as feature_usage_weight,
        {{ projection_feature('fg_shrink') }} as feature_fg_shrink,
        {{ projection_feature('ft_shrink') }} as feature_ft_shrink,
        {{ projection_feature('other_team_production') }} as feature_other_team
    from {{ ref('int_player_projection_parts') }}

),

weighted as (

    select
        *,
        -- weighted minutes: a past season on another team keeps other_team_production of its weight
        rate_weight_cur
            + (rate_weight_prev - (1 - feature_other_team) * rate_weight_other_prev)
            + (rate_weight_prev2 - (1 - feature_other_team) * rate_weight_other_prev2)
            + prior_minutes as rate_weight,
        {%- for s in production %}
        wsum_{{ s }} - (1 - feature_other_team) * wsum_other_{{ s }} + prior_games * prior_{{ s }}_pg as total_{{ s }},
        {%- endfor %}
        (pace_wsum + prior_minutes * coalesce(prior_pace, 0))
            / nullif(pace_weight + case when prior_pace is null then 0 else prior_minutes end, 0) as pace_basis,
        (usage_wsum + prior_minutes * coalesce(prior_usage_rate, 0))
            / nullif(usage_weight + case when prior_usage_rate is null then 0 else prior_minutes end, 0) as usage_basis,
        (usage_wsum + (feature_usage_weight - 1) * usage_wsum_cur + prior_minutes * coalesce(prior_usage_rate, 0))
            / nullif(usage_weight + (feature_usage_weight - 1) * usage_weight_cur
                + case when prior_usage_rate is null then 0 else prior_minutes end, 0) as usage_target
    from parts

),

factored as (

    select
        *,
        case
            when feature_pace = 0 or coalesce(pace_target, 0) <= 0 or coalesce(pace_basis, 0) <= 0 then 1.0
            else power(pace_target / pace_basis, feature_pace)
        end as pace_factor,
        case
            when feature_usage_weight = 1 or coalesce(usage_basis, 0) <= 0 or coalesce(usage_target, 0) <= 0 then 1.0
            else usage_target / usage_basis
        end as usage_factor
    from weighted

),

rated as (

    select
        *,
        {%- for s in production if s not in ('fgm', 'ftm') %}
        -- per minute: weighted totals plus the prior's, over weighted minutes plus the prior's
        total_{{ s }} / nullif(rate_weight, 0) * proj_minutes_pg * pace_factor{{ ' * usage_factor' if s in volume }} as proj_{{ s }}_pg,
        {%- endfor %}
        {%- for made, tried, shrink, pct in [('fgm', 'fga', 'feature_fg_shrink', 'league_field_goal_pct'), ('ftm', 'fta', 'feature_ft_shrink', 'league_free_throw_pct')] %}
        case
            when {{ shrink }} = 0 or {{ pct }} is null
                then total_{{ made }} / nullif(rate_weight, 0) * proj_minutes_pg * pace_factor * usage_factor
            -- makes at the shrunk percentage on the projected attempts
            else total_{{ tried }} / nullif(rate_weight, 0) * proj_minutes_pg * pace_factor * usage_factor
                * (total_{{ made }} + {{ shrink }} * {{ pct }}) / nullif(total_{{ tried }} + {{ shrink }}, 0)
        end as proj_{{ made }}_pg{{ "," if not loop.last }}
        {%- endfor %}
    from factored

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
    (rate_weight_prev - (1 - feature_other_team) * rate_weight_other_prev) / rate_weight as w_prev,
    (rate_weight_prev2 - (1 - feature_other_team) * rate_weight_other_prev2) / rate_weight as w_prev2,
    prior_minutes / rate_weight as w_prior,
    games_share,
    games_share_healthy,
    proj_minutes_pg,
    proj_minutes_season_pg,
    minutes_last5_pg,
    cast(absence_games as integer) as absence_games,
    cast(games_since_return as integer) as games_since_return,
    return_minutes_factor,
    pace_target,
    pace_basis,
    pace_factor,
    usage_target,
    usage_basis,
    usage_factor,
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
