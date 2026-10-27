# Databricks Asset Bundle

`databricks.yml` defines the `fantasyscout_build` job: the dbt project from this repo, run on serverless compute against the SQL warehouse, on a daily schedule. It is the same build that `.github/workflows/build.yml` runs from GitHub Actions after each ingest; the job exists so the transform schedule also lives inside the workspace, where notebooks and dashboards consume its output.

```bash
export DATABRICKS_HOST=https://<workspace-host>
export DATABRICKS_TOKEN=...
WAREHOUSE=$(curl -s -H "Authorization: Bearer $DATABRICKS_TOKEN" "$DATABRICKS_HOST/api/2.0/sql/warehouses" | jq -r '.warehouses[0].id')

cd bundles
databricks bundle validate -t prod --var="warehouse_id=$WAREHOUSE"
databricks bundle deploy   -t prod --var="warehouse_id=$WAREHOUSE"
databricks bundle run      -t prod fantasyscout_build --var="warehouse_id=$WAREHOUSE"
```

The schedule is deployed paused. Unpause it in the Jobs UI (or set `pause_status: UNPAUSED`) once a manual `bundle run` has succeeded; until then GitHub Actions is the only scheduled builder, so there is exactly one writer.
