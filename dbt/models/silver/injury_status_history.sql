{#
  Every status an injury listing has held, from the daily ESPN injury reports: one row per run of
  the same status, with the first and last report it appeared in. silver.injuries keeps only the
  latest listing; this keeps how it got there (Questionable, then Out, then Day-To-Day). A
  listing that stops appearing has come off the report. Reports are daily, so a date here is the
  ingest date of the report, not the hour the team announced it.
#}

with reports as (

    select
        league,
        season,
        injury_id,
        athlete_name,
        team_id,
        status,
        cast(_ingest_date as date) as report_date
    from {{ ref('espn_injuries') }}
    where injury_id is not null
    qualify row_number() over (partition by league, injury_id, _ingest_date order by _source_file desc) = 1

),

flagged as (

    select
        *,
        case when lag(status) over (partition by league, injury_id order by report_date) = status then 0 else 1 end as is_change
    from reports

),

runs as (

    select
        *,
        sum(is_change) over (
            partition by league, injury_id order by report_date rows between unbounded preceding and current row
        ) as run_no
    from flagged

)

select
    league,
    max(season) as season,
    injury_id,
    league || ':' || injury_id || ':' || cast(run_no as string) as status_run_key,
    run_no,
    max(athlete_name) as athlete_name,
    max(team_id) as team_id,
    status,
    min(report_date) as status_from,
    max(report_date) as status_to,
    count(*) as reports
from runs
group by league, injury_id, run_no, status
