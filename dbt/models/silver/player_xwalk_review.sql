{#
  Players in matched games that the crosswalk could not pair, from either side, with the
  closest candidate on the same team in the same games. The fix for a true pair is a row in
  seeds/player_id_overrides.csv (runbook, "Reconciliation review").
#}

with matched_games as (

    select league, game_id, event_id, game_date
    from {{ ref('game_xwalk') }}

),

stats_side as (

    select
        b.league,
        g.event_id,
        g.game_date,
        b.player_id,
        tx.espn_team_id,
        b.first_name || ' ' || b.family_name as player_name,
        {{ norm_name("b.first_name || ' ' || b.family_name") }} as norm_name,
        {{ norm_name("b.family_name || ' ' || b.first_name") }} as norm_name_reversed
    from {{ ref('player_game_box') }} as b
    join matched_games as g
        on g.league = b.league and g.game_id = b.game_id
    left join {{ ref('team_xwalk') }} as tx
        on tx.league = b.league and tx.stats_team_id = b.team_id

),

espn_side as (

    select
        e.league,
        e.event_id,
        g.game_date,
        e.athlete_id as player_id,
        e.team_id as espn_team_id,
        e.athlete_name as player_name,
        {{ norm_name('e.athlete_name') }} as norm_name,
        {{ norm_name(first_last_tokens('e.athlete_name')) }} as norm_first_last
    from {{ ref('espn_player_game') }} as e
    join matched_games as g
        on g.league = e.league and g.event_id = e.event_id

),

xwalk as (select * from {{ ref('player_xwalk') }}),

stats_unmatched as (

    select s.*
    from stats_side as s
    left join xwalk as x on x.league = s.league and x.stats_player_id = s.player_id
    where x.stats_player_id is null

),

espn_unmatched as (

    select e.*
    from espn_side as e
    left join xwalk as x on x.league = e.league and x.espn_player_id = e.player_id
    where x.espn_player_id is null

),

stats_candidates as (

    select
        s.league,
        s.player_id,
        e.player_id as candidate_id,
        e.player_name as candidate_name,
        max(greatest(
            {{ name_similarity('s.norm_name', 'e.norm_name') }},
            {{ name_similarity('s.norm_name_reversed', 'e.norm_name') }},
            {{ name_similarity('s.norm_name', 'e.norm_first_last') }}
        )) as similarity
    from stats_unmatched as s
    join espn_unmatched as e
        on e.league = s.league and e.event_id = s.event_id and e.espn_team_id = s.espn_team_id
    group by s.league, s.player_id, e.player_id, e.player_name

),

espn_candidates as (

    select
        e.league,
        e.player_id,
        s.player_id as candidate_id,
        s.player_name as candidate_name,
        max(greatest(
            {{ name_similarity('s.norm_name', 'e.norm_name') }},
            {{ name_similarity('s.norm_name_reversed', 'e.norm_name') }},
            {{ name_similarity('s.norm_name', 'e.norm_first_last') }}
        )) as similarity
    from espn_unmatched as e
    join stats_unmatched as s
        on s.league = e.league and s.event_id = e.event_id and s.espn_team_id = e.espn_team_id
    group by e.league, e.player_id, s.player_id, s.player_name

),

stats_rows as (

    select
        s.league,
        'stats' as side,
        s.player_id,
        max(s.player_name) as player_name,
        count(distinct s.event_id) as games,
        min(s.game_date) as first_game_date,
        max(s.game_date) as last_game_date
    from stats_unmatched as s
    group by s.league, s.player_id

),

espn_rows as (

    select
        e.league,
        'espn' as side,
        e.player_id,
        max(e.player_name) as player_name,
        count(distinct e.event_id) as games,
        min(e.game_date) as first_game_date,
        max(e.game_date) as last_game_date
    from espn_unmatched as e
    group by e.league, e.player_id

),

best_stats_candidate as (

    select * from stats_candidates
    qualify row_number() over (partition by league, player_id order by similarity desc, candidate_id) = 1

),

best_espn_candidate as (

    select * from espn_candidates
    qualify row_number() over (partition by league, player_id order by similarity desc, candidate_id) = 1

)

select
    r.league,
    r.side,
    r.player_id,
    r.league || ':' || r.side || ':' || r.player_id as review_key,
    r.player_name,
    r.games,
    r.first_game_date,
    r.last_game_date,
    c.candidate_id as best_candidate_id,
    c.candidate_name as best_candidate_name,
    c.similarity as best_similarity
from stats_rows as r
left join best_stats_candidate as c on c.league = r.league and c.player_id = r.player_id
union all
select
    r.league,
    r.side,
    r.player_id,
    r.league || ':' || r.side || ':' || r.player_id as review_key,
    r.player_name,
    r.games,
    r.first_game_date,
    r.last_game_date,
    c.candidate_id,
    c.candidate_name,
    c.similarity
from espn_rows as r
left join best_espn_candidate as c on c.league = r.league and c.player_id = r.player_id
