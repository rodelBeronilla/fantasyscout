{{ config(severity='warn', tags=['quality', 'board']) }}

-- Days the board ledger (fct_board_history) should hold a snapshot for but does not: every
-- Eastern date in the last 45 days, from the league's first snapshot on, while the league was
-- playing (a regular-season, play-in or playoff game within three days either side), with no row.
-- A failed nightly build leaves exactly such a hole, and the ledger is the only history of the
-- newer signals; the runbook ("Fill a hole in the board ledger") says how to put the day back
-- from a kept build. The 45-day window is what the kept builds can still fill with margin to
-- notice; an older hole is history.
with first_snapshot as (

    select league, min(snapshot_date) as first_day
    from {{ ref('fct_board_history') }}
    group by league

),

playing_days as (

    select distinct s.league, d.date_day
    from {{ ref('schedule') }} as s
    join {{ ref('dim_date') }} as d
        on d.date_day >= {{ add_days('s.game_date_est', -3) }}
        and d.date_day <= {{ add_days('s.game_date_est', 3) }}
    where s.game_type in ('regular', 'play_in', 'playoffs')

),

expected as (

    select p.league, p.date_day
    from playing_days as p
    join first_snapshot as f on f.league = p.league
    where p.date_day >= f.first_day
        and p.date_day >= {{ add_days(as_of_date(), -45) }}
        and p.date_day < {{ as_of_date() }}

),

snapshots as (

    select distinct league, snapshot_date
    from {{ ref('fct_board_history') }}

)

select e.league, e.date_day as missing_day
from expected as e
left join snapshots as s on s.league = e.league and s.snapshot_date = e.date_day
where s.snapshot_date is null
order by e.league, e.date_day
