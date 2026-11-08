{#
  How long injuries keep players out (#800, for #770): a Kaplan-Meier curve of games missed per
  league and body part, and per body part and kind, from the official reports' injury spells
  (fct_injury_spell, injuries only).

  At each count of games missed, at_risk is the spells that lasted at least that long, returned
  those that ended there with the player back, censored those still running when last seen
  (ongoing at the cut, or at season's end). survival is the share still out after that many games:
  the running product of (1 - returned / at_risk). A censored spell counts as at least what was
  seen and leaves the risk set after it, never as a short spell that ended. A group needs
  recovery_min_spells spells.
#}

with spells as (

    select
        league,
        body_part,
        injury_kind,
        games_missed as games,
        case when returned then 1 else 0 end as event
    from {{ ref('fct_injury_spell') }}
    where reason_group = 'injury' and body_part is not null and games_missed > 0

),

grouped as (

    select league, 'body_part' as level, body_part, cast(null as {{ dbt.type_string() }}) as injury_kind, games, event
    from spells
    union all
    select league, 'body_part_kind' as level, body_part, injury_kind, games, event
    from spells
    where injury_kind is not null

),

sized as (

    select *, count(*) over (partition by league, level, body_part, injury_kind) as spells
    from grouped

),

counts as (

    select
        league,
        level,
        body_part,
        injury_kind,
        max(spells) as spells,
        games,
        sum(event) as returned,
        count(*) - sum(event) as censored,
        count(*) as ended_here
    from sized
    where spells >= {{ var('recovery_min_spells') }}
    group by league, level, body_part, injury_kind, games

),

risk as (

    select
        *,
        sum(ended_here) over (
            partition by league, level, body_part, injury_kind order by games desc rows unbounded preceding
        ) as at_risk
    from counts

),

steps as (

    select
        *,
        max(case when returned = at_risk then 1 else 0 end) over (
            partition by league, level, body_part, injury_kind order by games rows unbounded preceding
        ) as all_back,
        sum(case when returned < at_risk then ln(1 - returned * 1.0 / at_risk) else 0 end) over (
            partition by league, level, body_part, injury_kind order by games rows unbounded preceding
        ) as log_survival
    from risk

)

select
    {{ sk(['league', 'level', 'body_part', "coalesce(injury_kind, '-')", 'games']) }} as recovery_curve_sk,
    league,
    level,
    body_part,
    injury_kind,
    cast(spells as integer) as spells,
    cast(games as integer) as games,
    cast(at_risk as integer) as at_risk,
    cast(returned as integer) as returned,
    cast(censored as integer) as censored,
    round(case when all_back = 1 then 0.0 else exp(log_survival) end, 6) as survival
from steps
