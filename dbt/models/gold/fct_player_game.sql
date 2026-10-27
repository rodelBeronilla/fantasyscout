{#
  Player × game: traditional box score with the advanced line joined, keyed to the dimensions.
  Where ESPN also reports the player-game, source_agreement carries the reconciliation verdict
  (exact, minor, conflict) and the resolution rule is applied: the league value wins, ESPN's
  fills in only where the league's is null (ADR 0005). Rows ESPN does not cover are
  'unverified'.
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

),

recon as (

    select * from {{ ref('player_game_reconciliation') }}

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
    coalesce(b.minutes, r.espn_minutes) as minutes,
    coalesce(b.minutes, r.espn_minutes) > 0 as played,
    coalesce(b.field_goals_made, r.espn_field_goals_made) as field_goals_made,
    coalesce(b.field_goals_attempted, r.espn_field_goals_attempted) as field_goals_attempted,
    coalesce(b.three_pointers_made, r.espn_three_pointers_made) as three_pointers_made,
    coalesce(b.three_pointers_attempted, r.espn_three_pointers_attempted) as three_pointers_attempted,
    coalesce(b.free_throws_made, r.espn_free_throws_made) as free_throws_made,
    coalesce(b.free_throws_attempted, r.espn_free_throws_attempted) as free_throws_attempted,
    b.rebounds_offensive,
    b.rebounds_defensive,
    coalesce(b.rebounds_total, r.espn_rebounds_total) as rebounds_total,
    coalesce(b.assists, r.espn_assists) as assists,
    coalesce(b.steals, r.espn_steals) as steals,
    coalesce(b.blocks, r.espn_blocks) as blocks,
    coalesce(b.turnovers, r.espn_turnovers) as turnovers,
    b.fouls_personal,
    coalesce(b.points, r.espn_points) as points,
    b.plus_minus,
    a.usage_percentage,
    a.true_shooting_percentage,
    a.effective_field_goal_percentage,
    a.offensive_rating as player_offensive_rating,
    a.defensive_rating as player_defensive_rating,
    a.net_rating as player_net_rating,
    a.pace as player_pace,
    a.pie,
    coalesce(r.source_agreement, 'unverified') as source_agreement,
    r.espn_player_id,
    b._ingest_date
from box as b
left join {{ ref('games') }} as g
    on g.league = b.league and g.game_id = b.game_id
left join adv as a
    on a.league = b.league and a.game_id = b.game_id and a.player_id = b.player_id
left join stint as s
    on s.league = b.league and s.stats_player_id = b.player_id
    and g.game_date >= s.valid_from and (s.valid_to is null or g.game_date <= s.valid_to)
left join recon as r
    on r.player_game_key = b.player_game_key
