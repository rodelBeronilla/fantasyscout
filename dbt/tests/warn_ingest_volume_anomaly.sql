{{ config(severity='warn', tags=['quality', 'volume']) }}

-- The latest run per source and league landed a payload count within 3 MAD of the median
-- of the trailing 14 runs (only once there are at least 5 earlier runs to compare with).
-- Full-refresh and backfill runs (explicit windows longer than 10 days) are left out.
with runs as (

    select
        source,
        league,
        run_id,
        started_at,
        landed + unchanged + skipped as payloads,
        row_number() over (partition by source, league order by started_at desc) as recency
    from {{ ref('ingest_log') }}
    where not full_refresh
        and {{ days_between('window_since', 'window_until') }} <= 10

),

latest as (

    select * from runs where recency = 1

),

prior as (

    select * from runs where recency between 2 and 15

),

med as (

    select source, league, median(payloads) as med_payloads, count(*) as prior_runs
    from prior
    group by source, league

),

mad as (

    select t.source, t.league, median(abs(t.payloads - m.med_payloads)) as mad_payloads
    from prior as t
    join med as m on m.source = t.source and m.league = t.league
    group by t.source, t.league

)

select
    l.source,
    l.league,
    l.run_id,
    l.payloads,
    m.med_payloads,
    d.mad_payloads,
    m.prior_runs
from latest as l
join med as m on m.source = l.source and m.league = l.league
join mad as d on d.source = l.source and d.league = l.league
where m.prior_runs >= 5
    and d.mad_payloads > 0
    and abs(l.payloads - m.med_payloads) > 3 * d.mad_payloads
