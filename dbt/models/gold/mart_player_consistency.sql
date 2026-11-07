{#
  Game-to-game consistency (#747): every game a player played this season, valued on the board's
  own scale, and the spread of those values.

  A game's value is the sum of its category z-scores against the season pool, the same pool and
  the same means and standard deviations mart_category_zscores uses for the season window (the
  top 180 NBA or 90 WNBA players by minutes): counting categories as (stat - pool mean) / pool sd,
  turnovers negative, and the percentages as the game's volume-weighted impact,
  (makes - pool pct x attempts), over the pool's impact sd. The mean of a player's game values is
  then close to their season z_total; the floor and ceiling are the 20th and 80th percentile games.
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
        g.player_id,
        {%- for c in counting %}
        {% if c == 'turnovers' %}-{% endif %}coalesce((g.{{ c }} - p.{{ c }}_mean) / nullif(p.{{ c }}_sd, 0), 0)
        {%- if not loop.last %} +{% endif %}
        {%- endfor %}
        + coalesce((g.field_goals_made - p.fg_pct * g.field_goals_attempted) / nullif(p.fg_impact_sd, 0), 0)
        + coalesce((g.free_throws_made - p.ft_pct * g.free_throws_attempted) / nullif(p.ft_impact_sd, 0), 0) as game_value
    from played as g
    join pool as p on p.league = g.league and p.season = g.season

)

select
    {{ sk(['league', 'season', 'player_id']) }} as consistency_sk,
    league,
    season,
    player_id,
    count(*) as games,
    avg(game_value) as game_value_mean,
    stddev_samp(game_value) as game_value_sd,
    {{ quantile('game_value', 0.2) }} as game_floor,
    {{ quantile('game_value', 0.8) }} as game_ceiling
from game_values
group by league, season, player_id
