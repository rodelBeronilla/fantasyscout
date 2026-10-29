{#
  Each player's injury statuses over time, linked to the league player id: one row per run of the
  same status on an injury listing (silver.injury_status_history), with the first and last daily
  report it appeared in. The player page draws a player's injury history from it.
#}

with players as (

    select league, injury_id, max(stats_player_id) as stats_player_id
    from {{ ref('fct_availability') }}
    group by league, injury_id

)

select
    {{ sk(['h.league', 'h.injury_id', 'cast(h.run_no as string)']) }} as injury_status_sk,
    h.league,
    h.season,
    h.injury_id,
    p.stats_player_id,
    h.athlete_name,
    h.status,
    case
        when lower(h.status) = 'out' then 'out'
        when lower(h.status) like 'day%' then 'day_to_day'
        when lower(h.status) like '%question%' then 'questionable'
        when lower(h.status) like '%doubt%' then 'doubtful'
        else 'other'
    end as status_group,
    h.status_from,
    h.status_to,
    h.reports
from {{ ref('injury_status_history') }} as h
left join players as p on p.league = h.league and p.injury_id = h.injury_id
