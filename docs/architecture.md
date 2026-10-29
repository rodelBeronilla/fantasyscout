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
          Cloudflare Worker "fantasyscout" at fantasyscout.beronilla.rodeo  (worker/)
            /*          static Astro build (web/dist)
            /data/*     R2 objects, Range-aware, immutable per build
            /auth/yahoo/*, /api/yahoo/*   optional Yahoo league import (ADR 0007)
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

## Reconciliation

The two sources share no ids. Three crosswalks in silver bridge them, rebuilt from the data on every build: `team_xwalk` (full name, nickname, abbreviation), `game_xwalk` (same teams on the same Eastern-time date) and `player_xwalk` (exact normalised name in the same team-game, then a fuzzy name match with birthdate confirmation, then `seeds/player_id_overrides.csv`). `player_game_reconciliation` compares thirteen values per player-game and judges it exact, minor or conflict; `ops.reconciliation` logs every differing value with the resolution (league wins, ESPN only where the league is null); `ops.reconciliation_summary` carries the match and conflict rates per league and season that Data Health shows; `fct_player_game.source_agreement` carries the verdict. Players the crosswalk cannot pair wait in `player_xwalk_review`. ADR 0005 has the reasoning, including the name-similarity function per engine.

## Serving

A passing gate publishes a data build to the `fantasyscout-data` bucket under `builds/<build_id>/` (one Parquet per gold model, JSON beside the small ones, the big facts per league-season, `board/` and `streamers/` per league, `health.json`, one file per player, `manifest.json`); `latest.json` is flipped last and seven builds are kept, so a rollback is one pointer rewrite (ADR 0006). The Worker serves the Astro build and streams `/data/*` from the bucket with range support; the pointers are cached for a minute, build files for a year. Every page reads `latest.json` first, so the whole site moves to a new build at once. The SQL console runs DuckDB-WASM in the browser over the build's Parquet files; its engine is served from the bucket because it is too large for a static asset. The Parquet files are private to the site's owner (ADR 0008): the Worker serves them only to a signed-in owner or to CI holding the owner's key, while the JSON the pages read stays public. The footer of every page names the data build and links to its Data Health entry.

## Analysis surfaces

Three doors onto the same gold tables (SPEC.md): the site's pages and SQL console; the notebooks under `notebooks/`, which read the published build over HTTP (or the local DuckDB file, or the lakehouse) through one helper, execute in CI against the sample and against every published build after the export, and are rendered under the build at `/notebooks/`; and the League Pulse workbook on Tableau Public, built from a three-file extract (`tableau/extract.py`) that every build refreshes, publishes next to the data and pushes into a Google Sheet (`tableau/sheets.py`), the one source Tableau Public refreshes on its own; the single manual publish is documented in `tableau/README.md` and the result is embedded on `/dashboards/`. The generated dbt docs (lineage graph, model and column definitions) are produced at deploy time and served at `/docs/`.

## Trust boundaries

- The Worker reads the static build and the R2 bucket. Its secrets are the owner's key, which guards the Parquet tables (ADR 0008), and the Yahoo app's client id and secret for the optional league import (ADR 0007); the manager's Yahoo tokens stay in an encrypted HttpOnly cookie and never reach the page.
- Every page credits NBA.com and WNBA.com for statistics and ESPN for schedules, rosters and injuries (ADR 0008). Its CSP allows `'wasm-unsafe-eval'` for DuckDB-WASM and frames only `public.tableau.com`.
- The export job is the only writer to R2 and runs only after the publish gate passes. `latest.json` flips last, so a half-uploaded build is never visible. The last seven builds stay for rollback.
- Secrets live in GitHub Actions secrets only: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `ANTHROPIC_API_KEY`, `OWNER_KEY` (copied into the Worker, and read by the notebooks and the Tableau extract), and optionally `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`, which the deploy copies into the Worker.
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
