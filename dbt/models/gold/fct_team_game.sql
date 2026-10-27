{# Team × game: totals from the game log, possessions, pace and ratings with the opponent joined. #}

with box as (

    select * from {{ ref('team_game_box') }}

),

with_poss as (

    select
        *,
        field_goals_attempted - rebounds_offensive + turnovers + 0.44 * free_throws_attempted as possessions,
        case when league = 'wnba' then 40.0 else 48.0 end as regulation_minutes
    from box

)

select
    {{ sk(['t.league', 't.game_id', 't.team_id']) }} as team_game_sk,
    {{ sk(['t.league', 't.game_id']) }} as game_sk,
    {{ sk(['t.league', 't.season', 't.team_id']) }} as team_sk,
    {{ sk(['t.league', 't.season', 'o.team_id']) }} as opponent_team_sk,
    t.team_game_key,
    t.league,
    t.season,
    t.game_id,
    t.game_date,
    t.team_id,
    t.team_abbreviation,
    o.team_id as opponent_team_id,
    o.team_abbreviation as opponent_abbreviation,
    t.is_home,
    t.win_loss,
    t.minutes as team_minutes,
    t.field_goals_made,
    t.field_goals_attempted,
    t.three_pointers_made,
    t.three_pointers_attempted,
    t.free_throws_made,
    t.free_throws_attempted,
    t.rebounds_offensive,
    t.rebounds_defensive,
    t.rebounds_total,
    t.assists,
    t.steals,
    t.blocks,
    t.turnovers,
    t.fouls_personal,
    t.points,
    o.points as opponent_points,
    t.plus_minus,
    t.possessions,
    o.possessions as opponent_possessions,
    -- Pace: possessions per regulation game; team minutes are the five-player total.
    case when t.minutes > 0 then t.possessions * t.regulation_minutes / (t.minutes / 5.0) end as pace,
    case when t.possessions > 0 then 100.0 * t.points / t.possessions end as offensive_rating,
    case when o.possessions > 0 then 100.0 * o.points / o.possessions end as defensive_rating,
    case when t.possessions > 0 and o.possessions > 0
        then 100.0 * t.points / t.possessions - 100.0 * o.points / o.possessions end as net_rating,
    t._ingest_date
from with_poss as t
left join with_poss as o
    on o.league = t.league and o.game_id = t.game_id and o.team_id <> t.team_id
