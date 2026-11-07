{#
  The value scale (#767, ADR 0019): one row per league and season with the pool's category means
  and spreads, its shooting percentages, the spread of the shooting impact, and each category's
  replacement level. Every value on the site is measured on it (macros/value_scale.sql), so a
  player's season, last twenty and ten games, single games and projection are all value per game
  above the league's replacement level, in the same units.

  One pool definition for every season: the fantasy league's pool_size players (teams x roster
  spots, the `fantasy` var), chosen in two passes. Pass zero orders by minutes; pass one
  standardises over its pool and ranks by value; pass two standardises over pass one's pool, so
  the means and spreads describe the players a league actually rosters. Replacement level is the
  average category score of the next `teams` players. The pool is never so large that no one is
  left to set replacement level.

  The lines are the board's projection for the season it values (mart_player_projection), and the
  regular-season lines for every other season (int_player_window_lines). A projection is already a
  per-game expectation shrunk toward replacement level, so it ranks as it stands. A past season's
  line is not, so it is shrunk the same way before it ranks or sets replacement level: by
  prior_games games (the `fantasy` var) at the level of the players just outside the pool by
  minutes, the line the projection's own prior comes from. A player with a few big or a few awful
  games then lands near replacement level rather than in the pool or the replacement band. Pass
  zero orders a projection by minutes per game and a past season by its total minutes.
#}

{% set counting = value_counting() %}
{% set zcats = value_categories() %}

with projection_seasons as (

    select distinct league, season from {{ ref('mart_player_projection') }}

),

lines as (

    select
        'projection' as source,
        league,
        season,
        player_id,
        -- a projection is already shrunk: it counts as one game with no prior
        1.0 as games,
        0.0 as prior_games,
        proj_minutes_pg as minutes_key,
        {%- for c in counting %}
        proj_{{ c }}_pg as {{ c }}_pg,
        {%- endfor %}
        proj_fgm_pg as fgm_pg,
        proj_fga_pg as fga_pg,
        proj_ftm_pg as ftm_pg,
        proj_fta_pg as fta_pg
    from {{ ref('mart_player_projection') }}

    union all

    select
        'season' as source,
        l.league,
        l.season,
        l.player_id,
        cast(l.games as double) as games,
        cast({{ fantasy_setting('prior_games', 'l.league') }} as double) as prior_games,
        l.total_minutes as minutes_key,
        {%- for c in counting %}
        l.{{ c }}_pg,
        {%- endfor %}
        l.fgm_pg,
        l.fga_pg,
        l.ftm_pg,
        l.fta_pg
    from {{ ref('int_player_window_lines') }} as l
    left join projection_seasons as ps on ps.league = l.league and ps.season = l.season
    where l.window_name = 'season' and ps.season is null

),

base as (

    select
        *,
        least(
            {{ fantasy_setting('pool_size') }},
            greatest(count(*) over (partition by league, season) - {{ fantasy_setting('teams') }}, 1)
        ) as pool,
        {{ fantasy_setting('teams') }} as teams,
        row_number() over (partition by league, season order by minutes_key desc, player_id) as pool_rank_0
    from lines

),

{% for n in [1, 2] %}
moments_{{ n }} as (

    select
        *,
        {%- for c in counting %}
        avg(case when pool_rank_{{ n - 1 }} <= pool then {{ c }}_pg end) over (partition by league, season) as mean_{{ c }},
        stddev_samp(case when pool_rank_{{ n - 1 }} <= pool then {{ c }}_pg end) over (partition by league, season) as sd_{{ c }},
        {%- endfor %}
        sum(case when pool_rank_{{ n - 1 }} <= pool then fgm_pg end) over (partition by league, season)
            / nullif(sum(case when pool_rank_{{ n - 1 }} <= pool then fga_pg end) over (partition by league, season), 0) as pool_field_goal_pct,
        sum(case when pool_rank_{{ n - 1 }} <= pool then ftm_pg end) over (partition by league, season)
            / nullif(sum(case when pool_rank_{{ n - 1 }} <= pool then fta_pg end) over (partition by league, season), 0) as pool_free_throw_pct
    from {{ 'base' if n == 1 else 'ranked_1' }}

),

impact_sd_{{ n }} as (

    select
        *,
        stddev_samp(case when pool_rank_{{ n - 1 }} <= pool then coalesce(fgm_pg - pool_field_goal_pct * fga_pg, 0) end)
            over (partition by league, season) as sd_fg_impact,
        stddev_samp(case when pool_rank_{{ n - 1 }} <= pool then coalesce(ftm_pg - pool_free_throw_pct * fta_pg, 0) end)
            over (partition by league, season) as sd_ft_impact
    from moments_{{ n }}

),

raw_{{ n }} as (

    select
        *,
        {%- for c in zcats %}
        {{ scale_score(c, pg_stat('s'), 's', above_replacement=false) }} as raw_{{ c }}_{{ n }}{{ "," if not loop.last }}
        {%- endfor %}
    from impact_sd_{{ n }} as s

),

scored_{{ n }} as (

    -- shrunk by prior_games games at the level of the players just outside the pool by minutes
    -- (a projection has no prior, so it stands as it is)
    select
        *,
        {%- for c in zcats %}
        (raw_{{ c }}_{{ n }} * games + prior_games * coalesce(avg(case when pool_rank_0 > pool and pool_rank_0 <= pool + teams then raw_{{ c }}_{{ n }} end)
            over (partition by league, season), 0)) / (games + prior_games) as z_{{ c }}_{{ n }}{{ "," if not loop.last }}
        {%- endfor %}
    from raw_{{ n }}

),

ranked_{{ n }} as (

    {#- the moments of this pass are dropped, so the next pass computes its own -#}
    select
        source, league, season, player_id, games, prior_games, minutes_key,
        {%- for c in counting %} {{ c }}_pg,{% endfor %}
        fgm_pg, fga_pg, ftm_pg, fta_pg, pool, teams,
        {%- for k in range(n) %} pool_rank_{{ k }},{% endfor %}
        {%- if n == 2 %}
        {%- for c in counting %} mean_{{ c }}, sd_{{ c }},{% endfor %}
        pool_field_goal_pct, pool_free_throw_pct, sd_fg_impact, sd_ft_impact,
        {%- for c in zcats %} z_{{ c }}_2,{% endfor %}
        {%- endif %}
        row_number() over (
            partition by league, season
            order by {% for c in zcats %}z_{{ c }}_{{ n }}{{ " + " if not loop.last }}{% endfor %} desc, player_id
        ) as pool_rank_{{ n }}
    from scored_{{ n }}

),
{% endfor %}

scale as (

    select
        league,
        season,
        max(source) as source,
        max(pool) as pool,
        max(teams) as teams,
        count(*) as players,
        {%- for c in counting %}
        max(mean_{{ c }}) as mean_{{ c }},
        max(sd_{{ c }}) as sd_{{ c }},
        {%- endfor %}
        max(pool_field_goal_pct) as pool_field_goal_pct,
        max(pool_free_throw_pct) as pool_free_throw_pct,
        max(sd_fg_impact) as sd_fg_impact,
        max(sd_ft_impact) as sd_ft_impact,
        {%- for c in zcats %}
        coalesce(avg(case when pool_rank_2 > pool and pool_rank_2 <= pool + teams then z_{{ c }}_2 end), 0) as repl_z_{{ c }}{{ "," if not loop.last }}
        {%- endfor %}
    from ranked_2
    group by league, season

)

select
    {{ sk(['league', 'season']) }} as value_scale_sk,
    *
from scale
