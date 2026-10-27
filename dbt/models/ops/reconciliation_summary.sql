{{ config(materialized='table') }}

{#
  Match and conflict rates per league and season (SPEC.md phase 4, "done when"): how many of
  the league's player-games ESPN also reports and the crosswalk pairs, and how those pairs
  agree. Two rates: over every line the league's box score carries, and over the lines where
  the player was on the floor. The league lists inactive players with a line of zeros and
  ESPN leaves them out, so the played rate is the one the coverage check judges. Data Health
  reads this table.
#}

with player_games as (

    select league, season, player_game_key, coalesce(minutes, 0) > 0 as played
    from {{ ref('player_game_box') }}

),

compared as (

    select player_game_key, source_agreement
    from {{ ref('player_game_reconciliation') }}

),

joined as (

    select
        p.league,
        p.season,
        p.player_game_key,
        p.played,
        c.source_agreement
    from player_games as p
    left join compared as c on c.player_game_key = p.player_game_key

)

select
    league,
    season,
    league || ':' || season as summary_key,
    count(*) as player_games,
    count(source_agreement) as matched,
    count(*) - count(source_agreement) as unmatched,
    cast(count(source_agreement) as double) / count(*) as match_rate,
    sum(case when played then 1 else 0 end) as played_player_games,
    sum(case when played and source_agreement is not null then 1 else 0 end) as played_matched,
    case
        when sum(case when played then 1 else 0 end) = 0 then null
        else cast(sum(case when played and source_agreement is not null then 1 else 0 end) as double)
            / sum(case when played then 1 else 0 end)
    end as played_match_rate,
    sum(case when source_agreement = 'exact' then 1 else 0 end) as exact,
    sum(case when source_agreement = 'minor' then 1 else 0 end) as minor,
    sum(case when source_agreement = 'conflict' then 1 else 0 end) as conflict,
    case
        when count(source_agreement) = 0 then null
        else cast(sum(case when source_agreement = 'conflict' then 1 else 0 end) as double) / count(source_agreement)
    end as conflict_rate,
    {{ now_ts() }} as summarised_at
from joined
group by league, season
