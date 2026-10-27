{#
  Per-league, per-season, per-window z-scores for the nine categories.

  The pool is the top 180 NBA or top 90 WNBA players by total minutes in the window; means and
  standard deviations come from the pool only. Counting categories use per-game averages.
  Percentages use a volume-weighted impact: (player pct - pool pct) x player attempts per game,
  standardised over the pool. Turnovers count negative.
#}

{% set counting = ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers'] %}
{% set windows = [('season', none), ('last_10', 10), ('last_20', 20)] %}

with played as (

    select
        *,
        row_number() over (partition by league, season, player_id order by game_date desc, game_id desc) as recency
    from {{ ref('fct_player_game') }}
    where played

),

per_player as (

    {% for name, n in windows %}
    select
        '{{ name }}' as window_name,
        league,
        season,
        player_id,
        count(*) as games,
        sum(minutes) as total_minutes,
        avg(minutes) as minutes_pg,
        {%- for c in counting %}
        avg({{ c }}) as {{ c }}_pg,
        {%- endfor %}
        sum(field_goals_made) as fgm,
        sum(field_goals_attempted) as fga,
        sum(free_throws_made) as ftm,
        sum(free_throws_attempted) as fta,
        avg(field_goals_attempted) as fga_pg,
        avg(free_throws_attempted) as fta_pg
    from played
    {% if n %}where recency <= {{ n }}{% endif %}
    group by league, season, player_id
    {{ "union all" if not loop.last }}
    {% endfor %}

),

ranked as (

    select
        *,
        fgm / nullif(fga, 0) as field_goal_pct,
        ftm / nullif(fta, 0) as free_throw_pct,
        row_number() over (partition by window_name, league, season order by total_minutes desc, player_id) as minutes_rank,
        case when league = 'wnba' then 90 else 180 end as pool_size
    from per_player

),

pooled as (

    select
        *,
        minutes_rank <= pool_size as in_pool,
        {%- for c in counting %}
        avg(case when minutes_rank <= pool_size then {{ c }}_pg end) over (partition by window_name, league, season) as pool_{{ c }}_mean,
        stddev_samp(case when minutes_rank <= pool_size then {{ c }}_pg end) over (partition by window_name, league, season) as pool_{{ c }}_sd,
        {%- endfor %}
        sum(case when minutes_rank <= pool_size then fgm end) over (partition by window_name, league, season)
            / nullif(sum(case when minutes_rank <= pool_size then fga end) over (partition by window_name, league, season), 0) as pool_field_goal_pct,
        sum(case when minutes_rank <= pool_size then ftm end) over (partition by window_name, league, season)
            / nullif(sum(case when minutes_rank <= pool_size then fta end) over (partition by window_name, league, season), 0) as pool_free_throw_pct
    from ranked

),

impacts as (

    select
        *,
        (field_goal_pct - pool_field_goal_pct) * fga_pg as fg_impact,
        (free_throw_pct - pool_free_throw_pct) * fta_pg as ft_impact
    from pooled

),

standardised as (

    select
        *,
        stddev_samp(case when in_pool then fg_impact end) over (partition by window_name, league, season) as pool_fg_impact_sd,
        stddev_samp(case when in_pool then ft_impact end) over (partition by window_name, league, season) as pool_ft_impact_sd
    from impacts

)

select
    {{ sk(['window_name', 'league', 'season', 'player_id']) }} as zscore_sk,
    window_name,
    league,
    season,
    player_id,
    games,
    minutes_pg,
    in_pool,
    {%- for c in counting %}
    {{ c }}_pg,
    {%- endfor %}
    field_goal_pct,
    free_throw_pct,
    fga_pg,
    fta_pg,
    {%- for c in counting %}
    {% if c == 'turnovers' %}-{% endif %}({{ c }}_pg - pool_{{ c }}_mean) / nullif(pool_{{ c }}_sd, 0) as z_{{ c }},
    {%- endfor %}
    fg_impact / nullif(pool_fg_impact_sd, 0) as z_field_goal_pct,
    ft_impact / nullif(pool_ft_impact_sd, 0) as z_free_throw_pct,
    coalesce((points_pg - pool_points_mean) / nullif(pool_points_sd, 0), 0)
        + coalesce((rebounds_total_pg - pool_rebounds_total_mean) / nullif(pool_rebounds_total_sd, 0), 0)
        + coalesce((assists_pg - pool_assists_mean) / nullif(pool_assists_sd, 0), 0)
        + coalesce((steals_pg - pool_steals_mean) / nullif(pool_steals_sd, 0), 0)
        + coalesce((blocks_pg - pool_blocks_mean) / nullif(pool_blocks_sd, 0), 0)
        + coalesce((three_pointers_made_pg - pool_three_pointers_made_mean) / nullif(pool_three_pointers_made_sd, 0), 0)
        - coalesce((turnovers_pg - pool_turnovers_mean) / nullif(pool_turnovers_sd, 0), 0)
        + coalesce(fg_impact / nullif(pool_fg_impact_sd, 0), 0)
        + coalesce(ft_impact / nullif(pool_ft_impact_sd, 0), 0) as z_total
from standardised
