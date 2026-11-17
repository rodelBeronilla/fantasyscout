{{ config(severity='warn', tags=['player']) }}

-- fct_player_week loses and adds nothing (#997): for every league, season and player, its weeks
-- add up to fct_player_game's regular-season totals, exactly for the games and the counting
-- columns. Minutes are fractions summed in another order, so they may differ in the last bits of
-- a double and no more. Runs on every build, the sample's included.
with games as (

    select
        league,
        season,
        player_id,
        cast(sum(case when played then 1 else 0 end) as integer) as games_played,
        coalesce(sum(minutes), 0) as minutes,
        {%- for c in ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'field_goals_made', 'field_goals_attempted', 'free_throws_made', 'free_throws_attempted'] %}
        coalesce(sum({{ c }}), 0) as {{ c }}{{ "," if not loop.last }}
        {%- endfor %}
    from {{ ref('fct_player_game') }}
    where {{ is_regular_season('game_id') }}
    group by league, season, player_id

),

weeks as (

    select
        league,
        season,
        player_id,
        cast(sum(games_played) as integer) as games_played,
        sum(minutes) as minutes,
        {%- for c in ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'field_goals_made', 'field_goals_attempted', 'free_throws_made', 'free_throws_attempted'] %}
        sum({{ c }}) as {{ c }}{{ "," if not loop.last }}
        {%- endfor %}
    from {{ ref('fct_player_week') }}
    group by league, season, player_id

)

select
    coalesce(g.league, w.league) as league,
    coalesce(g.season, w.season) as season,
    coalesce(g.player_id, w.player_id) as player_id,
    g.games_played as game_games_played,
    w.games_played as week_games_played,
    g.points as game_points,
    w.points as week_points,
    g.minutes as game_minutes,
    w.minutes as week_minutes
from games as g
full outer join weeks as w
    on w.league = g.league and w.season = g.season and w.player_id = g.player_id
where g.player_id is null
    or w.player_id is null
    or abs(g.minutes - w.minutes) > 1e-6
    {%- for c in ['games_played', 'points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers', 'field_goals_made', 'field_goals_attempted', 'free_throws_made', 'free_throws_attempted'] %}
    or g.{{ c }} <> w.{{ c }}
    {%- endfor %}
