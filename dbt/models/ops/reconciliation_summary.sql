{{ config(materialized='table') }}

{#
  Match and conflict rates per league and season (SPEC.md phase 4, "done when"): how many of
  the league's player-games ESPN also reports and the crosswalk pairs, and how those pairs
  agree. Data Health reads this table.
#}

with player_games as (

    select league, season, player_game_key
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
