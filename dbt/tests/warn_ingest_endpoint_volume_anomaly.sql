{{ config(severity='warn', tags=['quality', 'volume']) }}

-- An endpoint whose latest run landed a payload count per window day more than three spreads from
-- the median of its trailing 14 runs (ops.ingest_endpoint_volume, #398). The source-level check
-- (warn_ingest_volume_anomaly) sums a source's endpoints, so one endpoint that stops landing moves
-- the total by a few percent and never warns there.
select source, league, endpoint, run_id, payloads, per_day, med_per_day, spread, prior_runs
from {{ ref('ingest_endpoint_volume') }}
where is_anomaly
