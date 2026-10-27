{#
  Player × game: traditional box score with the advanced line joined, keyed to the dimensions.
  source_agreement is set by the reconciliation in phase 4; until then every row is 'unverified'.
#}

with box as (

    select * from {{ ref('player_game_box') }}

),

adv as (

    select * from {{ ref('player_game_advanced') }}

),

stint as (

    select league, stats_player_id, player_sk, valid_from, valid_to
    from {{ ref('dim_player') }}

)

select
    {{ sk(['b.league', 'b.game_id', 'b.player_id']) }} as player_game_sk,
    s.player_sk,
    {{ sk(['b.league', 'b.game_id']) }} as game_sk,
    {{ sk(['b.league', 'b.season', 'b.team_id']) }} as team_sk,
    b.player_game_key,
    b.league,
    b.season,
    b.game_id,
    g.game_date,
    b.player_id,
    b.team_id,
    b.team_tricode,
    b.side = 'home' as is_home,
    b.position,
    b.comment,
    b.minutes,
    b.minutes > 0 as played,
    b.field_goals_made,
    b.field_goals_attempted,
    b.three_pointers_made,
    b.three_pointers_attempted,
    b.free_throws_made,
    b.free_throws_attempted,
    b.rebounds_offensive,
    b.rebounds_defensive,
    b.rebounds_total,
    b.assists,
    b.steals,
    b.blocks,
    b.turnovers,
    b.fouls_personal,
    b.points,
    b.plus_minus,
    a.usage_percentage,
    a.true_shooting_percentage,
    a.effective_field_goal_percentage,
    a.offensive_rating as player_offensive_rating,
    a.defensive_rating as player_defensive_rating,
    a.net_rating as player_net_rating,
    a.pace as player_pace,
    a.pie,
    'unverified' as source_agreement,
    b._ingest_date
from box as b
left join {{ ref('games') }} as g
    on g.league = b.league and g.game_id = b.game_id
left join adv as a
    on a.league = b.league and a.game_id = b.game_id and a.player_id = b.player_id
left join stint as s
    on s.league = b.league and s.stats_player_id = b.player_id
    and g.game_date >= s.valid_from and (s.valid_to is null or g.game_date <= s.valid_to)
