{#
  League stats API player id to ESPN athlete id, one row per matched player (SPEC.md,
  "Reconciliation"). Three passes over the players who appear in matched games:

  1. exact: the same normalised name, in either token order ("Xu Han" is "Han Xu"), on the
     same team in the same game;
  2. fuzzy: among players neither pass matched, a name similarity above the engine's
     threshold within the same team-game, the bar lowered when the rosters give the same
     birthdate (ADR 0005);
  3. override: seeds/player_id_overrides.csv, which beats both.

  A pair has to be the best for the stats player and the best for the ESPN athlete. Players
  left without a pair are listed in player_xwalk_review.
#}

with matched_games as (

    select league, season, game_id, event_id, game_date
    from {{ ref('game_xwalk') }}

),

stats_side as (

    select
        b.league,
        b.game_id,
        g.event_id,
        g.game_date,
        b.player_id as stats_player_id,
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
        e.athlete_id as espn_player_id,
        e.team_id as espn_team_id,
        e.athlete_name as player_name,
        {{ norm_name('e.athlete_name') }} as norm_name
    from {{ ref('espn_player_game') }} as e
    join matched_games as g
        on g.league = e.league and g.event_id = e.event_id

),

exact_pairs as (

    select
        s.league,
        s.stats_player_id,
        e.espn_player_id,
        count(*) as games_matched,
        min(s.game_date) as first_game_date,
        max(s.game_date) as last_game_date
    from stats_side as s
    join espn_side as e
        on e.league = s.league
        and e.event_id = s.event_id
        and e.espn_team_id = s.espn_team_id
        and (e.norm_name = s.norm_name or e.norm_name = s.norm_name_reversed)
    group by s.league, s.stats_player_id, e.espn_player_id

),

exact_best as (

    select * from (
        select
            *,
            row_number() over (partition by league, stats_player_id order by games_matched desc, espn_player_id) as rk_s,
            row_number() over (partition by league, espn_player_id order by games_matched desc, stats_player_id) as rk_e
        from exact_pairs
    ) as ranked
    where rk_s = 1 and rk_e = 1

),

stats_unmatched as (

    select s.*
    from stats_side as s
    left join exact_best as x
        on x.league = s.league and x.stats_player_id = s.stats_player_id
    where x.stats_player_id is null

),

espn_unmatched as (

    select e.*
    from espn_side as e
    left join exact_best as x
        on x.league = e.league and x.espn_player_id = e.espn_player_id
    where x.espn_player_id is null

),

stats_birthdates as (

    select league, player_id, max({{ stats_birth_date('birth_date') }}) as birth_date
    from {{ ref('rosters') }}
    group by league, player_id

),

espn_birthdates as (

    select league, athlete_id, birth_date
    from {{ ref('espn_roster_players') }}
    where birth_date is not null

),

fuzzy_candidates as (

    select
        s.league,
        s.stats_player_id,
        e.espn_player_id,
        s.game_date,
        greatest(
            {{ name_similarity('s.norm_name', 'e.norm_name') }},
            {{ name_similarity('s.norm_name_reversed', 'e.norm_name') }}
        ) as similarity
    from stats_unmatched as s
    join espn_unmatched as e
        on e.league = s.league
        and e.event_id = s.event_id
        and e.espn_team_id = s.espn_team_id

),

fuzzy_pairs as (

    select
        c.league,
        c.stats_player_id,
        c.espn_player_id,
        max(c.similarity) as similarity,
        count(*) as games_matched,
        min(c.game_date) as first_game_date,
        max(c.game_date) as last_game_date,
        max(case when sb.birth_date is not null and sb.birth_date = eb.birth_date then 1 else 0 end) = 1 as birthdate_match
    from fuzzy_candidates as c
    left join stats_birthdates as sb
        on sb.league = c.league and sb.player_id = c.stats_player_id
    left join espn_birthdates as eb
        on eb.league = c.league and eb.athlete_id = c.espn_player_id
    group by c.league, c.stats_player_id, c.espn_player_id

),

fuzzy_accepted as (

    select *
    from fuzzy_pairs
    where similarity >= {{ name_similarity_threshold() }}
        or (birthdate_match and similarity >= {{ name_similarity_threshold_with_birthdate() }})

),

fuzzy_best as (

    select * from (
        select
            *,
            row_number() over (
                partition by league, stats_player_id
                order by case when birthdate_match then 0 else 1 end, similarity desc, games_matched desc, espn_player_id
            ) as rk_s,
            row_number() over (
                partition by league, espn_player_id
                order by case when birthdate_match then 0 else 1 end, similarity desc, games_matched desc, stats_player_id
            ) as rk_e
        from fuzzy_accepted
    ) as ranked
    where rk_s = 1 and rk_e = 1

),

overrides as (

    select
        league,
        cast(stats_player_id as string) as stats_player_id,
        cast(espn_player_id as string) as espn_player_id,
        reason
    from {{ ref('player_id_overrides') }}
    where stats_player_id is not null and espn_player_id is not null

),

unioned as (

    select league, stats_player_id, espn_player_id, 'override' as method, 0 as priority,
        cast(null as double) as similarity, cast(null as bigint) as games_matched,
        cast(null as date) as first_game_date, cast(null as date) as last_game_date, reason as note
    from overrides
    union all
    select league, stats_player_id, espn_player_id, 'exact', 1,
        cast(1.0 as double), games_matched, first_game_date, last_game_date, cast(null as string)
    from exact_best
    union all
    select league, stats_player_id, espn_player_id, 'fuzzy', 2,
        similarity, games_matched, first_game_date, last_game_date,
        case when birthdate_match then 'birthdate confirmed' else 'name only' end
    from fuzzy_best

),

best_per_stats_player as (

    select *
    from unioned
    qualify row_number() over (partition by league, stats_player_id order by priority, espn_player_id) = 1

),

best_per_espn_player as (

    select *
    from best_per_stats_player
    qualify row_number() over (partition by league, espn_player_id order by priority, stats_player_id) = 1

)

select
    league,
    stats_player_id,
    espn_player_id,
    league || ':' || stats_player_id as player_xwalk_key,
    method,
    similarity,
    games_matched,
    first_game_date,
    last_game_date,
    note
from best_per_espn_player
