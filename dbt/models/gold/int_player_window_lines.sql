{#
  Each player's per-game line over a window of a season (#767): the whole season, the last twenty
  and the last ten games played. Regular-season games only: the games fantasy leagues score, so
  playoff games never move a player's form or a past season's line. A missing box-score number in
  a game played counts as zero, as int_player_game_value scores it, so a player's mean game value
  is exactly their season line's value. Lines only; int_value_scale
  and mart_category_zscores put them on the value scale, and mart_player_projection reads the
  season lines.
#}

{% set windows = [('season', none), ('last_10', 10), ('last_20', 20)] %}

with played as (

    select
        *,
        row_number() over (partition by league, season, player_id order by game_date desc, game_id desc) as recency
    from {{ ref('fct_player_game') }}
    where played and {{ is_regular_season('game_id') }}

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
        {%- for c in value_counting() %}
        avg(coalesce({{ c }}, 0)) as {{ c }}_pg,
        {%- endfor %}
        sum(coalesce(field_goals_made, 0)) as fgm,
        sum(coalesce(field_goals_attempted, 0)) as fga,
        sum(coalesce(free_throws_made, 0)) as ftm,
        sum(coalesce(free_throws_attempted, 0)) as fta,
        avg(coalesce(field_goals_made, 0)) as fgm_pg,
        avg(coalesce(field_goals_attempted, 0)) as fga_pg,
        avg(coalesce(free_throws_made, 0)) as ftm_pg,
        avg(coalesce(free_throws_attempted, 0)) as fta_pg
    from played
    {% if n %}where recency <= {{ n }}{% endif %}
    group by league, season, player_id
    {{ "union all" if not loop.last }}
    {% endfor %}

)

select
    *,
    fgm / nullif(fga, 0) as field_goal_pct,
    ftm / nullif(fta, 0) as free_throw_pct
from per_player
