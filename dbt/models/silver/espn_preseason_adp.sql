{#
  Each past season's preseason market (#786): ESPN fantasy's average draft position per player, as
  a history run landed it once (bronze.espn_fantasy_adp), with the player's rank by it. The
  walk-forward harness judges the preseason board against it (#769).

  - Known the day before the season's first regular-season game: draft position comes from the
    drafts, which are done by tip-off, so a point-in-time build sees a season's draft position
    from then on, whenever the history run landed it. The schedule is identity data and is not
    cut, so the date is there for a season not yet played.
  - Only a real draft position counts: ESPN gives some players 0. The rank breaks ties by player.
  - The final ownership ESPN shows for a past season is end-of-season knowledge and is left out.
#}

with first_game as (

    select league, season, min(game_date_est) as first_game_date
    from {{ ref('schedule') }}
    where game_type = 'regular'
    group by league, season

),

landed as (

    select *
    from {{ ref('espn_fantasy_adp') }}
    where espn_player_id is not null
        and try_cast(average_draft_position as double) > 0
    qualify row_number() over (
        partition by league, season, espn_player_id order by _ingest_date desc, _source_file desc
    ) = 1

),

dated as (

    select
        l.league,
        l.season,
        l.espn_player_id,
        l.full_name,
        l.espn_team_id,
        try_cast(l.average_draft_position as double) as average_draft_position,
        {{ add_days('f.first_game_date', -1) }} as known_date
    from landed as l
    join first_game as f on f.league = l.league and f.season = l.season

)

select
    league || ':' || season || ':' || espn_player_id as preseason_adp_key,
    league,
    season,
    espn_player_id,
    full_name,
    espn_team_id,
    average_draft_position,
    cast(rank() over (partition by league, season order by average_draft_position, espn_player_id) as integer) as adp_rank,
    known_date
from dated
where {{ known_before('known_date') }}
