{{ config(severity='warn', tags=['quality', 'volume']) }}

-- The latest run per source and league landed a payload count per window day within 3 MAD of the
-- median of the trailing 14 runs (only once there are at least 5 earlier runs to compare with).
-- Full-refresh and backfill runs (explicit windows longer than 10 days) are left out.
--
-- A run is judged whole (#393): the stats job logs one record per pass (the regular season, then
-- the playoffs), so its last record was a playoffs pass that found no games, 37 payloads against a
-- median of 185. The passes of a run are summed, the count is taken per day of the run's window
-- (a one-day run and a seven-day run are not compared alike), and the spread is floored at a tenth
-- of the median or two payloads a day, so a source that lands nearly the same count every day does
-- not warn on a difference of a few payloads.
with records as (

    select
        source,
        league,
        run_id,
        started_at,
        landed + unchanged + skipped as payloads,
        {{ days_between('window_since', 'window_until') }} + 1 as window_days
    from {{ ref('ingest_log') }}
    where not full_refresh
        and {{ days_between('window_since', 'window_until') }} <= 10

),

runs as (

    select
        source,
        league,
        run_id,
        min(started_at) as started_at,
        sum(payloads) as payloads,
        sum(payloads) * 1.0 / greatest(max(window_days), 1) as per_day
    from records
    group by source, league, run_id

),

ranked as (

    select *, row_number() over (partition by source, league order by started_at desc) as recency
    from runs

),

latest as (

    select * from ranked where recency = 1

),

prior as (

    select * from ranked where recency between 2 and 15

),

med as (

    select source, league, median(per_day) as med_per_day, count(*) as prior_runs
    from prior
    group by source, league

),

mad as (

    select t.source, t.league, median(abs(t.per_day - m.med_per_day)) as mad_per_day
    from prior as t
    join med as m on m.source = t.source and m.league = t.league
    group by t.source, t.league

)

select
    l.source,
    l.league,
    l.run_id,
    l.payloads,
    l.per_day,
    m.med_per_day,
    d.mad_per_day,
    greatest(d.mad_per_day, 0.1 * m.med_per_day, 2) as spread,
    m.prior_runs
from latest as l
join med as m on m.source = l.source and m.league = l.league
join mad as d on d.source = l.source and d.league = l.league
where m.prior_runs >= 5
    and abs(l.per_day - m.med_per_day) > 3 * greatest(d.mad_per_day, 0.1 * m.med_per_day, 2)
