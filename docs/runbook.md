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

A WNBA season is about 240 games × 4 endpoints at roughly 2.3 s per request, so budget about 40 minutes per season for the stats API.

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

## Roll back a data build (phase 5)

To be written with the export job.
