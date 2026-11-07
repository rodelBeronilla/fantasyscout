{#
  Every played game valued on the board's own scale (#747, #749): the sum of the game's category
  z-scores against the season pool, the same pool, means and standard deviations
  mart_category_zscores uses for the season window (the top 180 NBA or 90 WNBA players by
  minutes). Counting categories are (stat - pool mean) / pool sd, turnovers negative; the
  percentages are the game's volume-weighted impact, (makes - pool pct x attempts), over the
  pool's impact sd. A player's mean game value is their season z_total. mart_player_consistency
  reads it for a player's spread, mart_defense_vs_position for what a defence gives up.
#}

{% set counting = ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers'] %}

with played as (

    select *
    from {{ ref('fct_player_game') }}
    where played

),

per_player as (

    select
        league,
        season,
        player_id,
        sum(minutes) as total_minutes,
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
    group by league, season, player_id

),

ranked as (

    select
        *,
        row_number() over (partition by league, season order by total_minutes desc, player_id)
            <= case when league = 'wnba' then 90 else 180 end as in_pool
    from per_player

),

pool_pct as (

    select
        league,
        season,
        sum(fgm) / nullif(sum(fga), 0) as pool_field_goal_pct,
        sum(ftm) / nullif(sum(fta), 0) as pool_free_throw_pct
    from ranked
    where in_pool
    group by league, season

),

pool as (

    select
        r.league,
        r.season,
        {%- for c in counting %}
        avg({{ c }}_pg) as {{ c }}_mean,
        stddev_samp({{ c }}_pg) as {{ c }}_sd,
        {%- endfor %}
        max(p.pool_field_goal_pct) as fg_pct,
        max(p.pool_free_throw_pct) as ft_pct,
        stddev_samp((r.fgm / nullif(r.fga, 0) - p.pool_field_goal_pct) * r.fga_pg) as fg_impact_sd,
        stddev_samp((r.ftm / nullif(r.fta, 0) - p.pool_free_throw_pct) * r.fta_pg) as ft_impact_sd
    from ranked as r
    join pool_pct as p on p.league = r.league and p.season = r.season
    where r.in_pool
    group by r.league, r.season

),

game_values as (

    select
        g.league,
        g.season,
        g.game_id,
        g.game_date,
        g.team_id,
        g.player_id,
        g.player_sk,
        g.minutes,
        {%- for c in counting %}
        {% if c == 'turnovers' %}-{% endif %}coalesce((g.{{ c }} - p.{{ c }}_mean) / nullif(p.{{ c }}_sd, 0), 0)
        {%- if not loop.last %} +{% endif %}
        {%- endfor %}
        + coalesce((g.field_goals_made - p.fg_pct * g.field_goals_attempted) / nullif(p.fg_impact_sd, 0), 0)
        + coalesce((g.free_throws_made - p.ft_pct * g.free_throws_attempted) / nullif(p.ft_impact_sd, 0), 0) as game_value
    from played as g
    join pool as p on p.league = g.league and p.season = g.season

)

select * from game_values
