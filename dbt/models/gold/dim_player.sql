{#
  One row per player per team stint (SCD type 2 on team). Stints come from where the player
  actually appeared in box scores, which is true for every backfilled season; the player
  directory and rosters add names, position and biography. valid_to is null for the current
  stint.
#}

with appearances as (

    select
        b.league,
        b.player_id,
        b.team_id,
        g.game_date,
        b.game_id,
        lag(b.team_id) over (partition by b.league, b.player_id order by g.game_date, b.game_id) as prev_team_id
    from {{ ref('player_game_box') }} as b
    join {{ ref('games') }} as g
        on g.league = b.league and g.game_id = b.game_id

),

stint_starts as (

    select
        league,
        player_id,
        team_id,
        game_date as valid_from
    from appearances
    where prev_team_id is null or prev_team_id <> team_id

),

stints as (

    select
        league,
        player_id,
        team_id,
        valid_from,
        lead(valid_from) over (partition by league, player_id order by valid_from) as next_valid_from
    from stint_starts

),

box_position as (

    -- The position a player is listed at when starting, most often, in the latest season
    -- they started a game: a fallback when neither roster carries one.
    select league, player_id, position
    from (
        select league, player_id, season, position, count(*) as n
        from {{ ref('player_game_box') }}
        where position is not null
        group by league, player_id, season, position
    ) as counted
    qualify row_number() over (partition by league, player_id order by season desc, n desc, position) = 1

),

last_game as (

    select league, player_id, max(game_date) as last_game_date
    from appearances
    group by league, player_id

),

bio as (

    select
        league,
        player_id,
        player_name,
        position,
        height,
        weight_lbs,
        birth_date,
        school,
        row_number() over (partition by league, player_id order by season desc, _ingest_date desc) = 1 as is_latest
    from {{ ref('rosters') }}

)

select
    {{ sk(['s.league', 's.player_id', "cast(s.valid_from as string)"]) }} as player_sk,
    s.league,
    s.player_id as stats_player_id,
    px.espn_player_id,
    coalesce(p.full_name, b.player_name) as full_name,
    coalesce(b.position, er.position, bp.position) as position,
    b.height,
    b.weight_lbs,
    b.birth_date,
    b.school,
    s.team_id,
    s.valid_from,
    case when s.next_valid_from is null then null else {{ add_days('s.next_valid_from', -1) }} end as valid_to,
    s.next_valid_from is null as is_current,
    lg.last_game_date
from stints as s
left join {{ ref('players') }} as p
    on p.league = s.league and p.player_id = s.player_id
left join bio as b
    on b.league = s.league and b.player_id = s.player_id and b.is_latest
left join last_game as lg
    on lg.league = s.league and lg.player_id = s.player_id
left join {{ ref('player_xwalk') }} as px
    on px.league = s.league and px.stats_player_id = s.player_id
left join {{ ref('espn_roster_players') }} as er
    on er.league = s.league and er.athlete_id = px.espn_player_id
left join box_position as bp
    on bp.league = s.league and bp.player_id = s.player_id
