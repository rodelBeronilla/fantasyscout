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

## When the site deploys

The "Deploy web" workflow runs when CI has passed on a push to `main` (production) or `preprod` (preview), and ships the very build CI tested: the `web-dist` and `dbt-docs` artifacts of that CI run, so nothing goes live that CI did not check and nothing is built twice. A push that touched neither `web/`, `worker/` nor the deploy workflow is not deployed. Run it by hand (Actions → Deploy web → Run workflow on a branch) to build and deploy without a CI run.

## Roll back a web deploy

Workers keep previous versions. From `worker/` with the token in the environment:

```bash
npx wrangler versions list --env production
npx wrangler rollback --env production      # interactive pick, or pass the version id
```

Rolling back the Worker does not touch R2 data; data rollback is a separate step (phase 5, `latest.json` pointer).

## Environments and pinned actions

Every job that holds the warehouse token or the R2 token runs in the `lakehouse` environment (Ingest, Backfill, Build, Export, Query, Probe); the deploys run in `preview` and `production`. An Export run that ignores the gate or rolls the site back runs in `lakehouse-override`, which requires the repository owner's approval before it starts (Actions → the run → Review deployments). The environments exist so the secrets can live there rather than at the repository level: moving `DATABRICKS_TOKEN`, `DATABRICKS_HOST`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` into `lakehouse` is a settings step for the owner (Settings → Environments → lakehouse → secrets), after which the repository-level copies can go.

The blocks every workflow shares live once, as composite actions under `.github/actions/`: `setup-uv` (uv and the locked environment), `databricks-context` (the workspace origin and the SQL warehouse — the repository variable `DATABRICKS_WAREHOUSE_ID` when set, else the oldest warehouse with a notice if there is more than one), `incident` (the data-incident issue) and `publish-build` (stage, notebooks, extract, promote: the one way a build goes live, used by the nightly build and the hand-run export alike).

Third-party actions are pinned to a commit SHA with the version in a comment; Dependabot (`.github/dependabot.yml`, the `github-actions` group) proposes the bumps and keeps the comments current. The home runner image is pinned by digest (`infra/runner/README.md`, "Update the runner image"); the Lighthouse check pins an exact version.

## Rotate a key

1. Create the new token or key at the provider.
2. Update the GitHub Actions secret. Re-run the latest deploy or build workflow to prove the new value works.
3. Revoke the old one at the provider. Check the next scheduled run is green.

## A narrower token for the ingest

The ingest and backfill jobs only ever write landed files (and read the landing indexes); the build, the export and the query need the SQL warehouse. The stats jobs also run on the home runners, the one place with residential egress, so the token they hold should be able to do nothing else. The workflows read `DATABRICKS_INGEST_TOKEN` for the ingest and backfill jobs and fall back to `DATABRICKS_TOKEN` while it is unset. To make the narrower token, in the workspace:

1. Create a service principal (Settings → Identity and access → Service principals), for example `fantasyscout-ingest`, and copy its **Application ID** (a UUID, on the principal's Configurations tab). Unity Catalog names a service principal by that id, never by its display name: a grant to the name fails with `PRINCIPAL_DOES_NOT_EXIST`.
2. Grant it what the landing needs and nothing more, as the owner in the SQL editor, with the id inside backticks: `GRANT USE CATALOG ON CATALOG fantasyscout TO `<application-id>``, `GRANT USE SCHEMA ON SCHEMA fantasyscout.raw TO `<application-id>``, `GRANT READ VOLUME, WRITE VOLUME ON VOLUME fantasyscout.raw.landing TO `<application-id>``. Check with `SHOW GRANTS `<application-id>` ON VOLUME fantasyscout.raw.landing`. No warehouse access, no other schema.
3. Give the principal a personal access token (the Files API takes a bearer token; an OAuth machine-to-machine token expires within the hour, too short for a backfill). Only the API can mint one for a service principal, as a workspace admin with their own token: `POST /api/2.0/token-management/on-behalf-of/tokens` with the body `{"application_id": "<application-id>", "lifetime_seconds": 7776000, "comment": "fantasyscout ingest and backfill"}`; the response's `token_value` is shown once. The lifetime above is 90 days; rotating it is the same call again.
4. Add it as the GitHub Actions secret `DATABRICKS_INGEST_TOKEN`; run Ingest by hand and check the landing step is green; rotate it on the schedule above.

Workload identity federation (no long-lived token at all) would be better still; whether Free Edition supports it is unverified, and the token above is the step that does not depend on that.

## The owner's sign-in (private tables)

The Parquet tables, and so the SQL console, are private to the site's owner (ADR 0008). The owner signs in with their Yahoo account through the Yahoo app (`YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`), using OpenID, which names the account (ADR 0008 addendum).

1. Open `/sql/` and choose **Sign in with Yahoo**. Until the owner is named, the page shows the account's id.
2. Save that id as the Actions secret `OWNER_YAHOO_GUID`. A repository variable of the same name also works, but use one or the other, not both.
3. Re-run Deploy web, then sign in again.

The nightly notebooks and the Tableau extract read the tables with a key derived from `YAHOO_CLIENT_SECRET`. Rotating the client secret in the Yahoo app (update the Actions secret, then re-run Deploy web) rotates that key and signs every browser out.

## Turn on the Yahoo league import

The League page can import an NBA league from Yahoo once the Worker has a Yahoo app's credentials (ADR 0007).

1. At developer.yahoo.com/apps, create an app with:
   - **Application type:** web application.
   - **Redirect URI:** `https://fantasyscout.beronilla.rodeo/auth/yahoo/callback`.
   - **API permissions:** Fantasy Sports, read.
2. Add its client id and client secret as the Actions secrets `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`.
3. Re-run the latest Deploy web run on main. The step "Give the Worker the Yahoo app's credentials" copies them into the Worker, and `/api/yahoo/status` should report `"configured":true`.
4. On the League page (NBA), sign in with Yahoo and import a league.

**Yahoo has to approve the app first.** Since July 2026, Yahoo gates the Fantasy Sports API behind an access program. Until an app is approved, sign-in works, but every Fantasy request answers 403 "This application is not authorized to perform this action", which the League page shows.

To get access:
1. Apply at https://sports.yahoo.com/developer/access/ with the app's App ID.
2. Sign the API access agreement Yahoo sends through DocuSign.
3. Submit the app's Client ID at https://sports.yahoo.com/developer/application-confirmation/.

Until then the import stays parked: the League page shows it as coming soon and the Worker keeps its Yahoo routes closed. Once Yahoo approves, set the repository variable `YAHOO_IMPORT` to `on` (Settings, then Secrets and variables, then Actions, then Variables) and re-run Deploy web on main.

Some approved apps only worked once they were recreated after approval. If so, put the new app's Client ID and Client Secret in the two secrets, re-run Deploy web, then sign out of Yahoo on the League page and sign in again. The old sign-in is tied to the old app.

To turn it off, delete the two secrets and remove them from the Worker (`wrangler secret delete YAHOO_CLIENT_ID --env production`, and the same for the secret). Rotating the client secret signs everyone out.

## Turn on The Odds API prop lines

Player prop lines are a private model input (ADR 0008 addendum). DraftKings' lines through ESPN land with every reports run and need nothing. The Odds API adds the other US bookmakers:

1. Create a key at the-odds-api.com.
2. Save it as the Actions secret `ODDS_API_KEY`. The reports job in Ingest passes it to `fs-ingest land reports`. Until it is set, that source is logged as skipped and the run does not fail.
3. Watch the credits in the run log (`odds api <league> <event>: cost 7, used ..., remaining ...`). Each event in the next 36 hours costs up to seven credits per run, one per market returned, and the run stops calling when fewer credits remain than one call costs.

To turn it off, delete the secret.

## Run the checks locally

See `CONTRIBUTING.md`. On Windows, Worker tests need the Visual C++ Redistributable for workerd; otherwise run them in a Linux container (the slim image lacks the CA certificates workerd needs):

```bash
docker run --rm -v "C:\path\to\fantasyscout:/repo:ro" -w /w node:24-bookworm bash -c \
  'mkdir -p /w/web && cp -r /repo/web/dist /w/web/dist && cp -r /repo/worker /w/worker && cd /w/worker && rm -rf node_modules && npm ci && npm test'
```

## One-time: create the catalog (Free Edition)

Free Edition refuses to create a catalog through the REST API unless a storage location is given, and custom locations are not allowed; the UI can create one on Default Storage. Once, in the workspace: **Catalog → Create catalog → name `fantasyscout` → Default storage → Create**. Everything below the catalog (the `raw` schema, the `landing` volume, later the bronze/silver/gold/ops schemas) is created by the code.

## Run an ingest by hand

The scheduled run keeps one process against each host: the stats jobs are one per league (two hosts, two home runners), the ESPN job runs its two leagues one after the other, and the reports job, whose feeds also read ESPN, waits for the ESPN job. A hand run with `league: both` does the same.

From the repo, with `DATABRICKS_HOST` and `DATABRICKS_TOKEN` in the environment for the volume backend (omit `--backend volume` to land under `./landing/` locally):

```bash
uv run fs-ingest land espn  --league wnba --backend volume                    # last 7 days
uv run fs-ingest land stats --league nba  --since 2026-10-21 --until 2026-10-27 --backend volume
uv run fs-ingest land stats --league wnba --dry-run                           # print the plan only
```

Every landed payload's sidecar (`<key>.meta.json`) records the request's latency, the attempts it took and the run id that made it, so a slow or flaky endpoint can be read off the volume (`select * from read_json('.../landing/stats/boxscoretraditionalv3/nba/*/*/*.meta.json')` in the SQL console works on the sample). Every run writes `landing/_ops/ingest_log/<date>/<source>-<league>-<season>-<run_id>.json` with counts and the list of failed requests. The process exits non-zero when any request failed, but everything that did land stays landed.

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

Backfills pass `--shots team-season`: the shot chart endpoint returns a whole season for one team in one request, so shots cost one call per team instead of one per game (the payload shape is identical; silver keeps the latest landing per shot). The advanced box line comes from the season-level `playergamelogs` endpoint, one request per season, so each game costs two calls (traditional box score, play-by-play). A WNBA season is then about 240 games × 2 endpoints plus a few dozen season and team calls at roughly 2.3 s per request, about 20 minutes; an NBA season about 1.7 hours (ADR 0004). That 2.3 s is the mandatory pacing gap, not upload time (measured 2026-10-27: overlapping uploads with the gap changed nothing); the only way to go faster is to run the two leagues at once, which the workflow does. NBA backfills also land player tracking and hustle by game date, six calls per date: about 1,350 more calls a season (regular season and playoffs), about 50 minutes (ADR 0004, 2026-10-30 addendum).

## Export and rollback

Every passing nightly build publishes a data build to the `fantasyscout-data` bucket: `builds/<build_id>/` holds the Parquet and JSON files, the per-player files and `manifest.json`; `latest.json` at the root points at the current build and `builds.json` lists the seven kept. The site reads `latest.json` first, so a build is only visible once every file is up. The nightly build stages a build, adds the notebooks and the Tableau extract to it, then promotes it (`builds.json`, then `latest.json`). To publish by hand, roll back, release a rollback or list what is served, run the "Export data" workflow with `build`, `rollback`, `unpin` or `list`. A hand-made `build` checks the latest publish gate first and refuses when it did not pass; set `ignore_gate` only in an emergency. A rollback pins the site until `unpin` (see "Roll back a data build"). Locally, `uv run fs-export build --engine duckdb --store local --out web/public/data` writes the same layout under the dev server's `/data/`.

## Incident issues

A failed job opens (or updates) a `data-incident` issue and the next passing run of the same job closes it. The title says which job, and the title routes the issue: ingest and backfill failures carry `area:ingest` and point at "Rerun a day" and "Replay failed fetches"; a build failure carries `area:lakehouse` and points at the publish gate section; a stale site (the watchdog) or a cancelled ingest carries `area:ops`. Issues are assigned to the repository owner; the `INCIDENT_ASSIGNEE` environment variable on a Report step names someone else (empty assigns nobody), and `AREA` / `PRIORITY` override the labels. An ingest run that GitHub cancelled or timed out (a self-hosted job queued for a day without a runner) opens an "Ingest cancelled: no build ran" incident from the Build workflow.

## Rerun a day

A run's date is the leagues' date, Eastern time: the payloads land under it, the default window ends on it, and every key that names a day uses it. A run after 8 pm Eastern, when the UTC date has already turned, still belongs to the evening (`ingest.landing.eastern_today`).

When an incident issue names a failed run:

1. Open the run link in the issue and read the `failed <endpoint>/<key>` lines.
2. Re-run the same window; keys already landed are skipped, failed ones are fetched again:
   ```bash
   uv run fs-ingest land <source> --league <league> --since <date> --until <date> --backend volume
   ```
3. If a single payload is corrupt rather than missing, re-run with `--full-refresh` for that one day.
4. The next passing scheduled run closes the incident issue automatically.

A run that is cut short (a job timeout, a cancelled job, a runner restart) keeps what it landed: the per-scope indexes (`_index.json`) are written every 25 landings and once more when the run ends, however it ends, so the next run re-fetches at most the last few requests rather than the whole window.

## Late corrections: settling and the resettle sweep

A game's payloads (box scores, play-by-play, shot chart; ESPN's summary) are **settled** once landed two days after the game, and left alone after that. Two things keep that honest. A payload the ingestor found half-written (`ingest/complete.py`: a box score missing a team's players, a play-by-play without its closing action, an ESPN summary whose box score has no statistics yet) is flagged `complete: false` in the landing index and fetched again on every run until a whole one lands. And the leagues post stat corrections later than two days: run Ingest with `resettle_days` (or `fs-ingest land stats --resettle-days 14 ...`) to fetch the game payloads of the last N days again, settled or not; unchanged payloads land no new file, so the sweep costs requests, not storage.

## Replay failed fetches

`ops.fetch_failures` names every request a run could not land (Data Health, "Failed fetches"; `select * from fantasyscout.ops.fetch_failures order by started_at desc`). Redo exactly those keys, not the whole window:

```bash
# the failed and missing keys of one run, from its run log (the path is in the incident's log tail)
uv run fs-ingest land stats --league wnba --backend volume --from-run-log landing/_ops/ingest_log/2026-10-27/stats-wnba-2026-<run_id>.json
# or by hand: an endpoint, or an endpoint and key, repeatable
uv run fs-ingest land espn --league nba --backend volume --only summary:401736812 --only injuries
```

From the Actions tab, run Ingest with the `only` input (space-separated). The run still makes the requests it plans from (the game log and the player directory; a day's scoreboard and the teams list), skips everything else, and lands only what matches; a same-day key that already landed is not fetched again. `--only` and `--from-run-log` apply to the stats and espn sources; the reports feeds are a minute's work to rerun whole.

## When a source changes shape

The league stats API's `resultSets` are read by header name (`dbt/macros/stats.sql`: `stats_headers`, `stats_row_values`, `stats_cell`), not by position, so a column the API inserts changes nothing in bronze; a column it renames or removes comes through as null, and the silver `not_null` tests name it. For the ESPN and league JSON feeds, which are read by key, the same holds.

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

Bronze models are append-only and incremental on `_ingest_date`; a full refresh re-reads every landed file. Silver models rebuild from bronze each run and keep the latest landing per natural key. A feed the ingest re-lands whole every day (game logs, standings, schedule, directory, rosters) is read through `latest_snapshot()`, the newest landing per request key, before that (ADR 0004, 2026-11-01 addendum). The play-by-play chain (`events`, `shots`, `event_lineups`, and gold's `fct_event` and `fct_shot`) is the exception: it is incremental by game. A run recomputes the games with a landing on or after the table's newest landing and replaces their rows (`dbt/macros/incremental.sql`); the games nothing landed for are not read. A game a landing was pruned or corrected for is only re-read when it lands again, or on a full refresh, which rebuilds the chain from every landed file.

The evening ingest (23:00 UTC) lands the injury reports and the other evening feeds only, and the build it triggers is a **light build**: the Ingest run leaves an `ingest-plan` artifact naming what it landed, and Build selects `tag:feed_reports+ path:models/ops`, those feeds' bronze models and everything downstream of them (the board and streamers included) plus the ops tables. Every quality check still runs before the gate, the export and promote are full, and the notebooks and the Tableau extract wait for the morning's full build. A build run by hand, or after an ingest without the artifact, is a full build.

## Quality checks, results table and the publish gate

Every build writes one row per model and test to `ops.test_results` (check, model, severity, status, failing rows, run id) and one row to `ops.publish_gate`. The gate passes only when no error-severity check failed and no model errored; warn-severity failures publish and are reported. In the Build lakehouse workflow a blocked gate fails the run and opens or updates the "Build failure" incident issue; the next passing build closes it.

```sql
-- what blocked the last build?
select run_at, passed, reason from fantasyscout.ops.publish_gate order by run_at desc limit 5;
select check_name, model, severity, status, failures
from fantasyscout.ops.test_results where run_id = '<run_id>' and status <> 'pass';
```

Severities follow the spec: keys, arithmetic, box-score closure (except turnovers, see ADR 0003), in-season freshness and completeness are errors (`assert_freshness_in_season` for the games in gold; `assert_core_feeds_fresh` for a core source feed stale by more than two days past its allowance, `ops.feed_freshness.is_core`); minutes closure, event-to-box agreement, shot location sanity, team turnovers and ingest volume anomalies are warnings.

Every build also writes one row to `ops.build_log` from its Report step: the GitHub run and the ingest run that triggered it, the dbt invocation and its gate, the export's build id, the selector of a light build, each step's outcome and duration and how long the job queued for a runner (from the Actions API), and the rows per table the build published (from its manifest). The same facts go to the run's step summary, and Data Health lists the recent runs.

```sql
-- how long do builds take, and how long do they wait for a runner?
select finished_at, event, light, gate_passed, queue_seconds / 60 as queued_min, build_seconds / 60 as dbt_min, total_seconds / 60 as total_min
from fantasyscout.ops.build_log order by finished_at desc limit 20;
```

A build run by hand with a `select` input builds only those nodes, so dbt runs only their tests. The workflow then runs every `tag:quality` check as well (into `dbt/target/quality`), and the gate reads both result sets, so a selected build is judged against the whole lakehouse before anything is published; its `publish_gate.reason` starts with `selected build (<selector>)`.

The gate step also prints up to ten failing rows of every failed check (`--sample-failures N`, 0 disables), re-running the check's compiled query with a limit, and the incident comment carries that tail, so an incident names the rows, not only the count.

## Reconciliation review

`select * from fantasyscout.ops.reconciliation_summary order by league, season` shows how much of each season ESPN covers and how the two sources agree; `warn_crosswalk_coverage` flags a season under 99% matched. `select * from fantasyscout.silver.player_xwalk_review order by games desc` lists the players the crosswalk could not pair with the closest candidate on the same team. When the candidate is the same person (a nickname, a marriage, a transliteration), add a row to `dbt/seeds/player_id_overrides.csv` (league, stats id, ESPN id, reason) and open a PR; the next build pairs every game of theirs retroactively. When a whole team is unmatched, check `silver.team_xwalk` first: a renamed team needs its nickname in `team_reference.csv`. `select stat, count(*) from fantasyscout.ops.reconciliation group by 1 order by 2 desc` shows which values the sources disagree on most; a sudden rise usually means one source changed shape.

## Chaos drill

Prove the gate and the incident path on demand, without touching data: run the Build lakehouse workflow with the `chaos` input ticked. The `chaos_deliberate_failure` check fails at error severity, the gate blocks, the run fails and an incident issue opens. Run the workflow again without the input; the gate passes and the issue closes itself. Do this after any change to `ops/results.py`, `incident.py` or the build workflow.

## Job time limits

Every job has a `timeout-minutes`: the daily stats ingest 120 (15 to 30 minutes at the spec's pace, twice), ESPN and the reports 45, the dbt build 120 (25 to 55 minutes), the backfills 330 (one season per job). A job that reaches its limit is cancelled; its Report step still runs and opens the incident naming the step that hung, and the Build workflow's concurrency group is released for the next day. The stalled-job notes under "Backfill status" say how to read a stats job that stopped making progress.

## Publish SLA and the watchdog

While a league is playing, the site is expected to serve a build no older than **30 hours**: builds run after the morning and the evening ingest, so one missed build still fits. Out of season the limit is 72 hours. The "Publish watchdog" workflow checks this every six hours from a GitHub-hosted runner, outside the pipeline: it reads the site's `/data/latest.json` and the build's `health.json` (whose feeds say which leagues are in season) and judges the build's age. A stale build opens the "Publish stale" incident issue; the next fresh check closes it. Run it by hand from the Actions tab, or locally:

```bash
uv run python -m ops.watchdog --site https://fantasyscout.beronilla.rodeo
```

A stale incident means no Build lakehouse run promoted a build in time, which the pipeline's own incidents may not say: a home runner that is offline leaves the stats job queued (nothing runs, nothing reports), a schedule GitHub stopped firing produces no run at all, and a cancelled build never reaches its report step. Check, in order: the latest Ingest and Build runs and their conclusions; the home runners (`infra/runner`, "runner shows offline"); whether the schedules fired at all (GitHub disables them after 60 days without a push, and runs them late on busy hours). Then run Ingest and Build by hand.

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

## Fill a hole in the board ledger

`gold.fct_board_history` is the daily ledger of the board (one row per Eastern date, league and player) and the only history of the newer signals: every build merges the day's rows and a full refresh never rebuilds it. A nightly build that fails, or does not run, leaves a day without rows, and nothing else would say so. The warn check `warn_board_history_gaps` lists each missing day of the last 45 while the league was playing (it is in `ops.test_results` and on the Data Health page after every build). To put a day back:

1. Find a build that ran on the missing day. `uv run fs-export list --store r2` shows the kept builds with when they were created (seven are kept, so a hole older than a week has no source; the day is history and the warning stops after 45 days).
2. Download that build's ledger. The Parquet tables are private to the owner: signed in, open `/data/builds/<build id>/fct_board_history.parquet`; or fetch it the way the notebooks do, with the reader key derived from the Yahoo client secret (`notebooks/fs.py`, `FS_READER_SECRET`).
3. Put the file in the raw volume, under a folder of its own so no bronze model reads it (the Databricks CLI, signed in as the owner):
   ```bash
   databricks fs cp fct_board_history.parquet dbfs:/Volumes/fantasyscout/raw/recover/fct_board_history.parquet
   ```
4. Insert the day's rows, naming the columns so the order cannot be wrong, and only the day's rows (the file holds every day the ledger had when the build ran). Take the column list from `describe fantasyscout.gold.fct_board_history`; a kept build older than a change to the ledger lacks the columns added since, so leave those out of both lists and they stay null for the day:
   ```sql
   insert into fantasyscout.gold.fct_board_history (<the columns describe lists>)
   select <the same columns>
   from parquet.`/Volumes/fantasyscout/raw/recover/fct_board_history.parquet` as k
   where k.snapshot_date = date '2026-11-01'
     and not exists (select 1 from fantasyscout.gold.fct_board_history as h where h.board_history_sk = k.board_history_sk);
   ```
5. Remove the file from `recover/`, and run the next build (or `dbt test --select warn_board_history_gaps`): the day no longer appears.

## Cut a release

Versions are tags on `main`. Every PR carries a `release:*` label (the PR template asks for it) and `.github/release.yml` turns the labels into the release notes: breaking changes, features, fixes; `release:skip` and Dependabot's PRs stay out.

Run the "Release" workflow (Actions → Release → Run workflow) with the version, `MAJOR.MINOR.PATCH` without the `v`. It tags `main`, publishes the GitHub release with the generated notes and the data build the site was serving at that moment (its id and data-as-of dates), and opens a PR that bumps `pyproject.toml`; merge that PR. A version already tagged, or one that is not three numbers, fails the run before anything is written.

The tags so far mark the phases: `v0.1.0` phase 0 (skeleton live), `v0.2.0` phase 1 (ingest), `v0.3.0` phase 2 (lakehouse), `v0.4.0` phase 3 (gold and quality), `v0.5.0` phase 4 (reconciliation), `v0.6.0` phase 5 (serving and the app), `v0.7.0` phase 6 (analysis surfaces), `v0.8.0` the platform-hardening milestone.

## Remove a source on request

ADR 0008 commits the site to complying when a source objects to its use here, and the `/sources/` page tells an operator to open an issue. When one arrives:

1. **Acknowledge in the issue** the same day: what the site takes from the source (the `/sources/` entry), and that collection stops now and the data follows.
2. **Stop the ingest.** Remove the source's job from the ingest workflow (`ingest.yml`: the matrix entry or the `fs-ingest land <source>` step) and from the planners (`ingest/<source>.py` keeps its code until the next step) in a PR labelled `release:breaking`. For a feed inside a source (one ESPN endpoint), remove that endpoint from the planner only.
3. **Remove what was landed.** On the lakehouse, delete the source's folder in the landing volume and its bronze tables; the silver and gold models that read them go in the same PR (dbt will not build a model whose source is gone), with their columns taken out of the marts, the export's column lists and the site's types, and the fixture refreshed:
   ```sql
   -- after the PR that drops the models has merged and built
   drop table if exists fantasyscout.bronze.<source>_<endpoint>;
   ```
   ```bash
   databricks fs rm -r dbfs:/Volumes/fantasyscout/raw/landing/<source>
   ```
4. **Republish without it.** The next full build publishes a build without the source's data; the kept builds still hold it for up to seven days, so `fs-export prune` with `--keep 1` (or deleting the older builds' folders in R2 by their key lists) removes those copies at once; roll back is then not possible past that build, which the issue should say.
5. **Record it.** An ADR 0008 addendum naming the source, the date of the request and what was removed; the `/sources/` entry goes, and the footer's credit with it.

A request about a person's rows (a public athlete, coach or official) follows the same path for the rows that name them, with the ADR addendum describing the filter applied in silver.

