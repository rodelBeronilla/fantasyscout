{{ config(materialized='table') }}

{#
  One row per ingest run and endpoint (#398): the landed, unchanged, failed and missing counts the
  run log records for each endpoint, which ingest_log keeps as one JSON object. The source-level
  volume check sums a source's endpoints, so one endpoint that stops shifts the total by a few
  percent; ingest_endpoint_volume and warn_ingest_endpoint_volume_anomaly read this per endpoint.
#}

{{ ingest_endpoint_rows(ref('ingest_log')) }}
