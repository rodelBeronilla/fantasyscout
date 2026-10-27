{# One row per game: result from the game log, context from the schedule. #}

select
    {{ sk(['g.league', 'g.game_id']) }} as game_sk,
    g.league,
    g.season,
    g.game_id,
    case
        when g.game_id like '_02%' then 'Regular Season'
        when g.game_id like '_04%' then 'Playoffs'
        when g.game_id like '_01%' then 'Preseason'
        when g.game_id like '_03%' then 'All-Star'
        else 'Other'
    end as season_type,
    g.game_date,
    s.game_datetime_utc,
    g.home_team_id,
    {{ sk(['g.league', 'g.season', 'g.home_team_id']) }} as home_team_sk,
    g.home_team_abbreviation,
    g.away_team_id,
    {{ sk(['g.league', 'g.season', 'g.away_team_id']) }} as away_team_sk,
    g.away_team_abbreviation,
    g.home_points,
    g.away_points,
    g.winner_team_id,
    s.arena_name,
    s.arena_city,
    s.arena_state,
    s.is_neutral,
    s.game_status,
    s.game_status_text,
    s.week_number,
    s.game_label,
    s.series_text
from {{ ref('games') }} as g
left join {{ ref('schedule') }} as s
    on s.league = g.league and s.game_id = g.game_id
