{#
  Player × game with rolling 5/10/20-game averages of the nine categories. Percentages are
  volume-weighted over the window (makes over attempts), never averaged.
#}

{% set counting = ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'minutes'] %}
{% set windows = [5, 10, 20] %}

with played as (

    select *
    from {{ ref('fct_player_game') }}
    where played

)

select
    player_game_sk,
    player_sk,
    league,
    season,
    player_id,
    team_id,
    game_id,
    game_date,
    row_number() over (partition by league, season, player_id order by game_date, game_id) as game_number,
    {%- for w in windows %}
    {%- for c in counting %}
    avg({{ c }}) over (partition by league, season, player_id order by game_date, game_id rows between {{ w - 1 }} preceding and current row) as {{ c }}_avg_{{ w }},
    {%- endfor %}
    sum(field_goals_made) over (partition by league, season, player_id order by game_date, game_id rows between {{ w - 1 }} preceding and current row)
        / nullif(sum(field_goals_attempted) over (partition by league, season, player_id order by game_date, game_id rows between {{ w - 1 }} preceding and current row), 0) as field_goal_pct_{{ w }},
    sum(free_throws_made) over (partition by league, season, player_id order by game_date, game_id rows between {{ w - 1 }} preceding and current row)
        / nullif(sum(free_throws_attempted) over (partition by league, season, player_id order by game_date, game_id rows between {{ w - 1 }} preceding and current row), 0) as free_throw_pct_{{ w }},
    count(*) over (partition by league, season, player_id order by game_date, game_id rows between {{ w - 1 }} preceding and current row) as games_in_window_{{ w }}{{ "," if not loop.last }}
    {%- endfor %}
from played
