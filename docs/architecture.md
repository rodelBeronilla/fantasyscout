# Architecture

FantasyScout is three loosely coupled systems: ingestion in GitHub Actions, transformation in Databricks (with DuckDB as a stand-in), and a public app on Cloudflare that only ever reads exported gold data. The warehouse is never exposed to the internet. Everything runs on free tiers.

```
 stats.wnba.com / stats.nba.com      ESPN public JSON       NBA injury PDF
            │                               │                     │
            └──────────────┬────────────────┴─────────────────────┘
                           ▼
              GitHub Actions cron: ingest/  (Python, httpx, pydantic)
                           │  raw JSON + sidecar, idempotent by SHA-256
                           ▼
        Unity Catalog volume  fantasyscout.raw.landing   (Databricks Free Edition)
                           │
                           ▼
         dbt Core (dbt-databricks; dbt-duckdb for CI and local)
           bronze ─► silver ─► gold (star schema + fantasy marts) ─► ops
                           │  every check writes a row to ops.test_results
                           ▼
                 publish gate: all error-severity checks pass?
                   no ─► GitHub issue "data-incident", site keeps last good build
                   yes ─► export/: gold ─► Parquet (zstd) + JSON ─► R2 fantasyscout-data/{build_id}/
                                           manifest.json, then flip latest.json
                           │
                           ▼
          Cloudflare Worker "fantasyscout" at fantasyscout.beronilla.rodeo  (worker/, no secrets)
            /*          static Astro build (web/dist)
            /data/*     R2 objects, Range-aware, immutable per build
                           │
                           ▼
           Browser: Astro pages, React islands, DuckDB-WASM over Parquet
           Tableau Public embed · rendered notebooks · dbt docs
```

## Layers

| Layer | Choice | Where |
| --- | --- | --- |
| Ingestion | Python 3.12, `httpx`, `pydantic`; one module per source; CLI `fs-ingest` | `ingest/` |
| Orchestration | GitHub Actions cron for ingest; Databricks Jobs via Asset Bundles for transforms | `.github/workflows/`, `bundles/` |
| Landing (bronze) | Raw JSON as received, pushed to a Unity Catalog volume through the Files API | `ingest/landing.py` defines the layout |
| Warehouse | Databricks Free Edition: Delta, Unity Catalog, one 2X-Small SQL warehouse | `dbt/` |
| Transform | dbt Core, `dbt-databricks` target plus a `dbt-duckdb` target for CI; one SQL body per model, adapter-dispatched macros hide the engine differences | `dbt/` |
| Quality | dbt tests with the spec's severities, singular basketball-logic checks, `ops.test_results` and `ops.publish_gate` written after every build | `dbt/tests/`, `ops/results.py` |
| Serving | Nightly export of gold to Parquet and JSON on R2 | `export/` |
| Web app | Astro static build, Tailwind, React islands where needed | `web/` |
| Edge | Cloudflare Worker with the assets binding and an R2 binding, on a custom domain | `worker/` |
| BI | Tableau Public, embedded | `dashboards/` |
| AI | Anthropic Messages API; drafts notes only, every claim re-checked against gold | `ai/` |

## Trust boundaries

- The Worker holds no secrets. It reads the static build and public R2 objects. Its CSP allows `'wasm-unsafe-eval'` for DuckDB-WASM and frames only `public.tableau.com`.
- The export job is the only writer to R2 and runs only after the publish gate passes. `latest.json` flips last, so a half-uploaded build is never visible. The last seven builds stay for rollback.
- Secrets live in GitHub Actions secrets only: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `ANTHROPIC_API_KEY`.
- Raw payloads from the stats APIs are never redistributed; only derived gold tables are published.

## Hosting

The app has its own subdomain, `fantasyscout.beronilla.rodeo`, bound to the Worker as a Cloudflare custom domain. It shares no infrastructure with the personal site at the apex. A preview Worker on `workers.dev` deploys from the `preprod` branch. See [ADR 0001](adr/0001-hosting-path.md).

## Phase status

| Phase | Status |
| --- | --- |
| 0. Skeleton | Live at https://fantasyscout.beronilla.rodeo/ |
| 1. Ingest | Done: daily landing of the stats API (home runner) and ESPN (GitHub) into the `landing` volume |
| 2. Lakehouse | Done: bronze and silver dbt models pass on DuckDB (CI) and Databricks after every ingest; Asset Bundle job deployed |
| 3. Gold + quality | Built: star schema and marts on both engines, quality checks with severities, `ops.test_results`, publish gate, chaos drill; backfill landing |
| 4. Reconciliation | Not started |
| 5. Serving + app | Not started |
| 6. Analysis surfaces | Not started |
| 7. AI notes | Not started |
| 8. Polish | Not started |
