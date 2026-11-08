{#
  Expected recovery timelines (#800, for #770): per league and body part, and per body part and
  kind, the games an injury spell lasts, read off its Kaplan-Meier curve (fct_recovery_curve). The
  median is the first count of games by which half the spells had ended with the player back;
  the 25th and 75th percentiles likewise. A percentile the curve never reaches, because too many
  spells were still running when last seen, is null rather than guessed.
#}

with curve as (

    select * from {{ ref('fct_recovery_curve') }}

)

select
    {{ sk(['league', 'level', 'body_part', "coalesce(injury_kind, '-')"]) }} as recovery_timeline_sk,
    league,
    level,
    body_part,
    injury_kind,
    max(spells) as spells,
    cast(sum(censored) as integer) as censored,
    cast(min(case when survival <= 0.75 then games end) as integer) as p25_games,
    cast(min(case when survival <= 0.5 then games end) as integer) as median_games,
    cast(min(case when survival <= 0.25 then games end) as integer) as p75_games
from curve
group by league, level, body_part, injury_kind
