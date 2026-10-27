{#
  Every player-game both sources report, side by side, with the agreement verdict
  (SPEC.md, "Reconciliation"):

  - exact: every compared count agrees and minutes agree within half a minute (ESPN
    publishes whole minutes, the league publishes mm:ss), or neither source has the player
    on the floor (the league writes zeros for a player who did not play, ESPN writes nothing);
  - minor: the counts agree and minutes differ by at most one minute;
  - conflict: anything else.

  Only player-games in matched games for crosswalked players appear here; fct_player_game
  marks the rest 'unverified'.
#}

{% set counts = [
    'points', 'rebounds_total', 'assists', 'steals', 'blocks', 'turnovers',
    'field_goals_made', 'field_goals_attempted', 'three_pointers_made', 'three_pointers_attempted',
    'free_throws_made', 'free_throws_attempted',
] %}
{% set agree = [] %}
{% for c in counts %}{% do agree.append('agree_' ~ c) %}{% endfor %}
{% set counts_agree = '(' ~ (agree | join(' and ')) ~ ')' %}

with box as (

    select * from {{ ref('player_game_box') }}

),

paired as (

    select
        b.league,
        b.season,
        b.game_id,
        gx.event_id,
        b.player_id as stats_player_id,
        px.espn_player_id,
        b.player_game_key,
        b.minutes as stats_minutes,
        e.minutes as espn_minutes,
        {% for c in counts %}
        b.{{ c }} as stats_{{ c }},
        e.{{ c }} as espn_{{ c }},
        {% endfor %}
        b._ingest_date
    from box as b
    join {{ ref('game_xwalk') }} as gx
        on gx.league = b.league and gx.game_id = b.game_id
    join {{ ref('player_xwalk') }} as px
        on px.league = b.league and px.stats_player_id = b.player_id
    join {{ ref('espn_player_game') }} as e
        on e.league = b.league and e.event_id = gx.event_id and e.athlete_id = px.espn_player_id

),

judged as (

    select
        *,
        {% for c in counts %}
        {{ same_value('stats_' ~ c, 'espn_' ~ c) }} as agree_{{ c }},
        {% endfor %}
        case
            when stats_minutes is null and espn_minutes is null then 0.0
            when stats_minutes is null or espn_minutes is null then 999.0
            else abs(stats_minutes - espn_minutes)
        end as minutes_gap,
        coalesce(stats_minutes, 0) = 0
            and espn_minutes is null and espn_points is null and espn_field_goals_attempted is null
            as both_did_not_play
    from paired

)

select
    league,
    season,
    game_id,
    event_id,
    stats_player_id,
    espn_player_id,
    player_game_key,
    stats_minutes,
    espn_minutes,
    {% for c in counts %}
    stats_{{ c }},
    espn_{{ c }},
    {% endfor %}
    minutes_gap,
    both_did_not_play,
    {{ counts_agree }} as counts_agree,
    case
        when both_did_not_play then 'exact'
        when {{ counts_agree }} and minutes_gap <= 0.5 then 'exact'
        when {{ counts_agree }} and minutes_gap <= 1.0 then 'minor'
        else 'conflict'
    end as source_agreement,
    _ingest_date
from judged
