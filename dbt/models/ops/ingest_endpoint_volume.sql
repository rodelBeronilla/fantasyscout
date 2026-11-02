{{ config(materialized='table') }}

{#
  Each endpoint's latest run against its trailing runs (#398): the payloads it landed or found
  unchanged per day of the run's window, the median and the median absolute deviation of the 14
  runs before, and whether the latest is more than three spreads away. The rules are the
  source-level check's (warn_ingest_volume_anomaly, #393): a run's passes are summed, the count
  is per window day, full-refresh and backfill windows (over 10 days) are left out, at least five
  earlier runs are needed, and the spread is floored at a tenth of the median or two payloads a day.
#}

with records as (

    select
        source,
        league,
        endpoint,
        run_id,
        started_at,
        landed + unchanged as payloads,
        {{ days_between('window_since', 'window_until') }} + 1 as window_days
    from {{ ref('ingest_endpoint_log') }}
    where not coalesce(full_refresh, false)
        and {{ days_between('window_since', 'window_until') }} <= 10

),

runs as (

    select
        source,
        league,
        endpoint,
        run_id,
        min(started_at) as started_at,
        sum(payloads) as payloads,
        sum(payloads) * 1.0 / greatest(max(window_days), 1) as per_day
    from records
    group by source, league, endpoint, run_id

),

ranked as (

    select *, row_number() over (partition by source, league, endpoint order by started_at desc, run_id) as recency
    from runs

),

med as (

    select source, league, endpoint, median(per_day) as med_per_day, count(*) as prior_runs
    from ranked
    where recency between 2 and 15
    group by source, league, endpoint

),

mad as (

    select r.source, r.league, r.endpoint, median(abs(r.per_day - m.med_per_day)) as mad_per_day
    from ranked as r
    join med as m on m.source = r.source and m.league = r.league and m.endpoint = r.endpoint
    where r.recency between 2 and 15
    group by r.source, r.league, r.endpoint

)

select
    l.source,
    l.league,
    l.endpoint,
    l.run_id,
    l.started_at,
    l.payloads,
    l.per_day,
    m.med_per_day,
    d.mad_per_day,
    greatest(d.mad_per_day, 0.1 * m.med_per_day, 2) as spread,
    m.prior_runs,
    m.prior_runs >= 5
        and abs(l.per_day - m.med_per_day) > 3 * greatest(d.mad_per_day, 0.1 * m.med_per_day, 2) as is_anomaly
from ranked as l
join med as m on m.source = l.source and m.league = l.league and m.endpoint = l.endpoint
join mad as d on d.source = l.source and d.league = l.league and d.endpoint = l.endpoint
where l.recency = 1
