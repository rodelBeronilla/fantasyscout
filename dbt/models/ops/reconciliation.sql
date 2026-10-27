{{ config(materialized='table') }}

{#
  One row per value the two sources disagree on, with both values and the resolution
  (SPEC.md): the league stats API wins by default; ESPN wins only where the league value is
  null. Two disagreements are noise and are left out: a player neither source has on the
  floor (zeros against blanks), and minutes within half a minute (ESPN rounds to the minute).
  Rebuilt from the current comparison on every build; reconciled_at is the build time.
#}

{% set stats = [
    'minutes', 'points', 'rebounds_total', 'assists', 'steals', 'blocks', 'turnovers',
    'field_goals_made', 'field_goals_attempted', 'three_pointers_made', 'three_pointers_attempted',
    'free_throws_made', 'free_throws_attempted',
] %}

with compared as (

    select * from {{ ref('player_game_reconciliation') }}
    where not both_did_not_play

),

differences as (

    {% for s in stats %}
    select
        league,
        season,
        game_id,
        event_id,
        stats_player_id,
        espn_player_id,
        '{{ s }}' as stat,
        cast(stats_{{ s }} as double) as stats_value,
        cast(espn_{{ s }} as double) as espn_value
    from compared
    where not {{ same_value('stats_' ~ s, 'espn_' ~ s) }}
    {%- if s == 'minutes' %} and minutes_gap > 0.5{% endif %}
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

)

select
    league,
    season,
    game_id,
    event_id,
    stats_player_id,
    espn_player_id,
    stat,
    league || ':' || game_id || ':' || stats_player_id || ':' || stat as reconciliation_key,
    stats_value,
    espn_value,
    espn_value - stats_value as delta,
    case when stats_value is null then 'espn' else 'stats' end as resolution,
    coalesce(stats_value, espn_value) as resolved_value,
    {{ now_ts() }} as reconciled_at
from differences
