# Runbook

Operational procedures. Each section is a checklist someone can follow at 3 a.m. Sections marked "phase N" are filled in when that phase lands.

## First deploy (phase 0)

1. In Cloudflare, create an API token (My Profile → API Tokens → Create Custom Token) with:
   - Account → Workers Scripts → Edit
   - Account → Workers R2 Storage → Edit
   - Zone → Workers Routes → Edit, and Zone → DNS → Edit, both limited to the `beronilla.rodeo` zone (the custom domain is created on the first production deploy)
   Note the Account ID from Workers & Pages → Overview.
2. In the GitHub repo, add Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets and variables → Actions). Never put them anywhere else.
3. Enable R2 on the account once (dashboard → R2; it asks for a payment method even though the free tier covers this project). The deploy workflow creates the `fantasyscout-data` bucket itself if it is missing.
4. Preview: push `main` to `preprod` (or run the "Deploy web" workflow on `preprod`). The workflow prints the `workers.dev` URL and smoke-tests `/`.
5. Production: merge to `main`. The first run creates the custom domain `fantasyscout.beronilla.rodeo`; DNS and the certificate can take a minute, which the smoke test waits for.
6. Smoke test by hand:
   ```bash
   curl -sI https://fantasyscout.beronilla.rodeo/ | head -1                      # HTTP/2 200
   curl -s  https://fantasyscout.beronilla.rodeo/ | grep -o 'Build <code[^<]*</code>'
   curl -sI https://fantasyscout.beronilla.rodeo/data/latest.json | head -1      # 404 until the first export
   curl -sI https://fantasyscout.beronilla.rodeo/ | grep -ci content-security-policy   # 1
   ```

## Roll back a web deploy

Workers keep previous versions. From `worker/` with the token in the environment:

```bash
npx wrangler versions list --env production
npx wrangler rollback --env production      # interactive pick, or pass the version id
```

Rolling back the Worker does not touch R2 data; data rollback is a separate step (phase 5, `latest.json` pointer).

## Rotate a key

1. Create the new token or key at the provider.
2. Update the GitHub Actions secret. Re-run the latest deploy or build workflow to prove the new value works.
3. Revoke the old one at the provider. Check the next scheduled run is green.

## Run the checks locally

See `CONTRIBUTING.md`. On Windows, Worker tests need the Visual C++ Redistributable for workerd; otherwise run them in a Linux container (the slim image lacks the CA certificates workerd needs):

```bash
docker run --rm -v "C:\path\to\fantasyscout:/repo:ro" -w /w node:24-bookworm bash -c \
  'mkdir -p /w/web && cp -r /repo/web/dist /w/web/dist && cp -r /repo/worker /w/worker && cd /w/worker && rm -rf node_modules && npm ci && npm test'
```

## One-time: create the catalog (Free Edition)

Free Edition refuses to create a catalog through the REST API unless a storage location is given, and custom locations are not allowed; the UI can create one on Default Storage. Once, in the workspace: **Catalog → Create catalog → name `fantasyscout` → Default storage → Create**. Everything below the catalog (the `raw` schema, the `landing` volume, later the bronze/silver/gold/ops schemas) is created by the code.

## Run an ingest by hand

From the repo, with `DATABRICKS_HOST` and `DATABRICKS_TOKEN` in the environment for the volume backend (omit `--backend volume` to land under `./landing/` locally):

```bash
uv run fs-ingest land espn  --league wnba --backend volume                    # last 7 days
uv run fs-ingest land stats --league nba  --since 2026-10-21 --until 2026-10-27 --backend volume
uv run fs-ingest land stats --league wnba --dry-run                           # print the plan only
```

Every run writes `landing/_ops/ingest_log/<date>/<source>-<league>-<season>-<run_id>.json` with counts and the list of failed requests. The process exits non-zero when any request failed, but everything that did land stays landed.

The stats API only answers from a residential address (ADR 0002), so run `land stats` from the home machine or the self-hosted runner, never from a cloud runner. The runner itself (start, re-register, remove) is documented in `infra/runner/README.md`.

## Backfill

One season at a time, oldest first, from a residential address. Each command is idempotent: a payload already landed with the same hash is not written twice, so an interrupted backfill is simply re-run.

```bash
for season in 2018 2019 2020 2021 2022 2023 2024 2025 2026; do
  uv run fs-ingest land stats --league wnba --season "$season" --since "$season-05-01" --until "$season-10-31" --backend volume
  uv run fs-ingest land stats --league wnba --season "$season" --season-type Playoffs --since "$season-09-01" --until "$season-10-31" --backend volume
done
uv run fs-ingest land stats --league nba --season 2023-24 --since 2023-10-24 --until 2024-06-30 --backend volume
```

Backfills pass `--shots team-season`: the shot chart endpoint returns a whole season for one team in one request, so shots cost one call per team instead of one per game (the payload shape is identical; silver keeps the latest landing per shot). The advanced box line comes from the season-level `playergamelogs` endpoint, one request per season, so each game costs two calls (traditional box score, play-by-play). A WNBA season is then about 240 games × 2 endpoints plus a few dozen season and team calls at roughly 2.3 s per request, about 20 minutes; an NBA season about 1.7 hours (ADR 0004). That 2.3 s is the mandatory pacing gap, not upload time (measured 2026-10-27: overlapping uploads with the gap changed nothing); the only way to go faster is to run the two leagues at once, which the workflow does.

## Export and rollback

Every passing nightly build publishes a data build to the `fantasyscout-data` bucket: `builds/<build_id>/` holds the Parquet and JSON files, the per-player files and `manifest.json`; `latest.json` at the root points at the current build and `builds.json` lists the seven kept. The site reads `latest.json` first, so a build is only visible once every file is up. The nightly build stages a build, adds the notebooks and the Tableau extract to it, then promotes it (`builds.json`, then `latest.json`). To publish by hand, roll back, release a rollback or list what is served, run the "Export data" workflow with `build`, `rollback`, `unpin` or `list`. A hand-made `build` checks the latest publish gate first and refuses when it did not pass; set `ignore_gate` only in an emergency. A rollback pins the site until `unpin` (see "Roll back a data build"). Locally, `uv run fs-export build --engine duckdb --store local --out web/public/data` writes the same layout under the dev server's `/data/`.

## Rerun a day

When an incident issue names a failed run:

1. Open the run link in the issue and read the `failed <endpoint>/<key>` lines.
2. Re-run the same window; keys already landed are skipped, failed ones are fetched again:
   ```bash
   uv run fs-ingest land <source> --league <league> --since <date> --until <date> --backend volume
   ```
3. If a single payload is corrupt rather than missing, re-run with `--full-refresh` for that one day.
4. The next passing scheduled run closes the incident issue automatically.

## When a source changes shape

Landed payloads are raw, so a shape change breaks bronze parsing (phase 2), not landing.

1. Compare a fresh payload with the fixture in `tests/fixtures/<source>/<endpoint>.json`.
2. Re-record the fixture from a residential address, trim it to a few rows, and update the parser and its tests.
3. If an endpoint disappeared, mark it in the planner and open an ADR if a replacement endpoint changes the data model.

## Build the lakehouse by hand

The "Build lakehouse" workflow runs `dbt build` on Databricks after every successful ingest and by hand (Actions → Build lakehouse → Run workflow; tick "full refresh" to rebuild incremental models). Locally, against the SQL warehouse:

```bash
export DBT_PROFILES_DIR=dbt DBT_TARGET=databricks DATABRICKS_TOKEN=...
export DBT_DATABRICKS_HOST=<workspace-host without https://>
export DBT_DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/<id>     # GET /api/2.0/sql/warehouses
cd dbt && uv run dbt build --target databricks
```

Bronze models are append-only and incremental on `_ingest_date`; a full refresh re-reads every landed file. Silver models rebuild from bronze each run and keep the latest landing per natural key.

## Quality checks, results table and the publish gate

Every build writes one row per model and test to `ops.test_results` (check, model, severity, status, failing rows, run id) and one row to `ops.publish_gate`. The gate passes only when no error-severity check failed and no model errored; warn-severity failures publish and are reported. In the Build lakehouse workflow a blocked gate fails the run and opens or updates the "Build failure" incident issue; the next passing build closes it.

```sql
-- what blocked the last build?
select run_at, passed, reason from fantasyscout.ops.publish_gate order by run_at desc limit 5;
select check_name, model, severity, status, failures
from fantasyscout.ops.test_results where run_id = '<run_id>' and status <> 'pass';
```

Severities follow the spec: keys, arithmetic, box-score closure (except turnovers, see ADR 0003), in-season freshness and completeness are errors; minutes closure, event-to-box agreement, shot location sanity, team turnovers and ingest volume anomalies are warnings.

The gate step also prints up to ten failing rows of every failed check (`--sample-failures N`, 0 disables), re-running the check's compiled query with a limit, and the incident comment carries that tail, so an incident names the rows, not only the count.

## Reconciliation review

`select * from fantasyscout.ops.reconciliation_summary order by league, season` shows how much of each season ESPN covers and how the two sources agree; `warn_crosswalk_coverage` flags a season under 99% matched. `select * from fantasyscout.silver.player_xwalk_review order by games desc` lists the players the crosswalk could not pair with the closest candidate on the same team. When the candidate is the same person (a nickname, a marriage, a transliteration), add a row to `dbt/seeds/player_id_overrides.csv` (league, stats id, ESPN id, reason) and open a PR; the next build pairs every game of theirs retroactively. When a whole team is unmatched, check `silver.team_xwalk` first: a renamed team needs its nickname in `team_reference.csv`. `select stat, count(*) from fantasyscout.ops.reconciliation group by 1 order by 2 desc` shows which values the sources disagree on most; a sudden rise usually means one source changed shape.

## Chaos drill

Prove the gate and the incident path on demand, without touching data: run the Build lakehouse workflow with the `chaos` input ticked. The `chaos_deliberate_failure` check fails at error severity, the gate blocks, the run fails and an incident issue opens. Run the workflow again without the input; the gate passes and the issue closes itself. Do this after any change to `ops/results.py`, `incident.py` or the build workflow.

## Backfill status

`select source, league, season, count(*) runs, sum(landed) landed, sum(failures) failures from fantasyscout.ops.ingest_log group by 1,2,3 order by 1,2,3` shows what has landed. `assert_completeness` lists every final scheduled game still missing a box score or play-by-play; it stays red until the backfill finishes, which is the point.

While a job runs, its log (the `Land` step, or `land.log` in the runner's work directory) carries a `progress` line every 25 requests with the running rate; a healthy stats job shows 20 to 30 requests a minute. A job whose log has not gained a line in five minutes is stalled: the pacing never pauses longer than the 30 s cooldown after a rate limit, and a host that stops answering trips the circuit breaker within about a minute and fails the job. Should a job sit silent anyway, dump the process's Python stack from the runner host (`py-spy dump --pid <pid>` in a throwaway container sharing the runner's pid namespace) and compare with a fresh request from the same container; ADR 0004 records the one stall seen so far and what fixed it.

## Roll back a data build

Run the "Export data" workflow with `rollback`. Leave the build id blank to go back one build,
or give one from `list`. The site serves it within a minute, because the Worker caches
`latest.json` for 60 s.

A rollback **pins** the site. `latest.json` and that build's entry in `builds.json` say so, and
`list` shows it. While the pin holds, nightly builds still run, publish their files and are
recorded in `builds.json`, but they do not go live. Pruning never removes the pinned build.

When the problem is fixed, run the workflow with `unpin`. Leave the build id blank to go live
with the newest build, or name one.

Locally, the same commands are:

```
uv run fs-export rollback --store r2 [--to <id>]
uv run fs-export unpin --store r2 [--to <id>]
```
