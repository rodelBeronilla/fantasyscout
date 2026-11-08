# Architecture

FantasyScout is three loosely coupled systems: ingestion in GitHub Actions, transformation in Databricks (with DuckDB as a stand-in), and a public app on Cloudflare that only ever reads exported gold data. The warehouse is never exposed to the internet. Everything runs on free tiers.

```
 stats.wnba.com / stats.nba.com      ESPN public JSON       NBA injury PDF
            │                               │                     │
            └──────────────┬────────────────┴─────────────────────┘
                           ▼
   GitHub Actions: ingest/ (Python, httpx, pydantic), on a schedule and the home server's dispatch
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
| Orchestration | GitHub Actions: a schedule and the home server's dispatch (`infra/host/`) for the ingest, and the build (dbt, gate, export, promotion) after every completed ingest; the Asset Bundle's Databricks job is the paused fallback, deployed on dispatch only (ADR 0013) | `.github/workflows/`, `bundles/` |
| Landing (bronze) | Raw JSON as received, pushed to a Unity Catalog volume through the Files API | `ingest/landing.py` defines the layout |
| Warehouse | Databricks Free Edition: Delta, Unity Catalog, one 2X-Small SQL warehouse | `dbt/` |
| Transform | dbt Core, `dbt-databricks` target plus a `dbt-duckdb` target for CI; one SQL body per model, adapter-dispatched macros hide the engine differences | `dbt/` |
| Quality | dbt tests with the spec's severities, singular basketball-logic checks, `ops.test_results` and `ops.publish_gate` written after every build | `dbt/tests/`, `ops/results.py` |
| Serving | Nightly export of gold to Parquet and JSON on R2 | `export/` |
| Web app | Astro static build, Tailwind, React islands where needed | `web/` |
| Edge | Cloudflare Worker with the assets binding and an R2 binding, on a custom domain | `worker/` |
| BI | Tableau Public, embedded on `/dashboards/` | `tableau/` |
| AI | Anthropic Messages API; drafts notes only, every claim re-checked against gold | `ai/` |

## Reconciliation

The two sources share no ids. Three crosswalks in silver bridge them, rebuilt from the data on every build: `team_xwalk` (full name, nickname, abbreviation), `game_xwalk` (same teams on the same Eastern-time date) and `player_xwalk` (exact normalised name in the same team-game, then a fuzzy name match with birthdate confirmation, then `seeds/player_id_overrides.csv`). `player_game_reconciliation` compares thirteen values per player-game and judges it exact, minor or conflict; `ops.reconciliation` logs every differing value with the resolution (league wins, ESPN only where the league is null); `ops.reconciliation_summary` carries the match and conflict rates per league and season that Data Health shows; `fct_player_game.source_agreement` carries the verdict. Players the crosswalk cannot pair wait in `player_xwalk_review`. ADR 0005 has the reasoning, including the name-similarity function per engine.

## Serving

A passing gate publishes a data build to the `fantasyscout-data` bucket under `builds/<build_id>/` (one Parquet per gold model, JSON beside the small ones, the big facts per league-season, `board/` and `streamers/` per league, `health.json`, one file per player, `manifest.json`); `latest.json` is flipped last and seven builds are kept, so a rollback is one pointer rewrite (ADR 0006). The Worker serves the Astro build and streams `/data/*` from the bucket with range support; the pointers, each build's `keys.txt` and `index.json` files, and the `/data/current/` addresses are cached for a minute, every other build file for a year (ADR 0006, addendum of 2026-11-02). Every page reads `latest.json` first, so the whole site moves to a new build at once. The SQL console runs DuckDB-WASM in the browser over the build's Parquet files; its engine is served from the bucket because it is too large for a static asset. The Parquet files are private to the site's owner (ADR 0008): the Worker serves them only to the owner, signed in with their Yahoo account, or to CI with a key derived from the Yahoo client secret, while the JSON the pages read stays public. The footer of every page names the data build and links to its Data Health entry.

## Analysis surfaces

Three doors onto the same gold tables (as the original brief, SPEC.md, asked): the site's pages and SQL console; the notebooks under `notebooks/`, which read the published build over HTTP (or the local DuckDB file, or the lakehouse) through one helper, execute in CI against the sample and against every published build after the export, and are rendered under the build at `/notebooks/`; and the League Pulse workbook on Tableau Public, built from a three-file extract (`tableau/extract.py`) that every build refreshes, publishes next to the data and pushes into a Google Sheet (`tableau/sheets.py`), the one source Tableau Public refreshes on its own; the single manual publish is documented in `tableau/README.md` and the result is embedded on `/dashboards/`. The generated dbt docs (lineage graph, model and column definitions) are built in CI beside the site, shipped by the deploy with that same build, and served at `/docs/`.

## Trust boundaries

- The Worker reads the static build and the R2 bucket. Its secrets are the Yahoo app's client id and secret, which sign the owner in to the private Parquet tables (ADR 0008) and serve the optional league import (ADR 0007); the manager's Yahoo tokens stay in an encrypted HttpOnly cookie and never reach the page.
- Every page credits NBA.com and WNBA.com for statistics and ESPN for schedules, rosters and injuries (ADR 0008). Its CSP allows `'wasm-unsafe-eval'` for DuckDB-WASM and frames only `public.tableau.com`.
- The export job is the only writer to R2 and runs only after the publish gate passes. `latest.json` flips last, so a half-uploaded build is never visible. The last seven builds stay for rollback.
- Secrets live in GitHub Actions secrets only, at the repository level or in the `lakehouse` environment: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` (the ingest's service principal), `DATABRICKS_INGEST_TOKEN`, `ODDS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, and `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET` and `OWNER_YAHOO_GUID`, which the deploy copies into the Worker. The deploys run in the `preview` and `production` environments. Who reads each one and how to rotate it is the runbook's [secret inventory](runbook.md#secrets-inventory-and-rotation); phase 7's notes use a local model and need no key of their own (ADR 0017).
- Raw payloads from the stats APIs are never redistributed; only derived gold tables are published.

## Hosting

The app has its own subdomain, `fantasyscout.beronilla.rodeo`, bound to the Worker as a Cloudflare custom domain. It shares no infrastructure with the personal site at the apex. A preview Worker on `workers.dev` deploys from the `preprod` branch. See [ADR 0001](adr/0001-hosting-path.md).

## Data retention and privacy

**What is held.** Public statistics and public biography (name, position, height, weight, birth date, school, team) from the leagues' and ESPN's feeds, the waiver trends Sleeper publishes, the bookmakers' player lines The Odds API aggregates, the leagues' official injury reports and NBA.com's referee assignments. A visitor's watchlist, theme and league choice live in their own browser (`localStorage`, under the `fantasyscout:` namespace) and nowhere else, and the site reads no analytics beyond Cloudflare's aggregate request counts. The league setup lives there too, unless the visitor signs in with Yahoo to save it to an account (ADR 0016). Then the Worker stores each league's setup in the R2 bucket under `private/accounts/<id>/`, where the id is an HMAC of the Yahoo account id (the Yahoo id itself is never stored) and the public data route never serves the prefix. "Delete my saved data" on the League page removes everything stored for the account. Sign-ins keep a signed cookie and no token (ADR 0008).

**Where, and for how long.**

| Store | Holds | Kept |
| --- | --- | --- |
| Landing volume (Databricks, `fantasyscout.raw.landing`) | Every payload as landed, with its sidecar | Indefinitely as the record of what each source said each day; pruning of superseded daily snapshots is written down for when the volume passes 50 GB (ADR 0004 addendum) and has not been needed |
| Lakehouse tables (bronze, silver, gold, ops) | Derived rows | Rebuilt from the landing on every build; `fct_board_history` and the ops ledgers grow one row per day and are never pruned |
| Published builds (R2, `builds/<id>/`) | The derived JSON and Parquet the site serves | The newest seven, plus any build a rollback pinned; pruned by the export after each publish (ADR 0006) |
| Notebook renders and findings | HTML and aggregates per build | With the build they belong to (seven builds) |
| The Tableau extract's Google Sheet | Three CSVs of aggregates | Overwritten by each full build |
| GitHub Actions logs and artifacts | Run output, the ingest plan, the web build | GitHub's default retention (90 days for logs) |

**What is published.** Derived tables only; the Parquet mirror to the owner; prop lines to no one; notebooks as aggregates. The site's `/sources/` page says the same per source.

**Removal on request.** ADR 0008 commits the site to complying if a source objects. The runbook's "Remove a source on request" says how: stop the ingest, remove the landed files and the derived tables, republish without them, and record it. A person who appears in the data (every one of them a public athlete, coach or official) can ask the same way, through the repository's issues; there is no personal data to remove beyond what the sources publish, and the site would remove its copy of that.

## Phase status

| Phase | Status |
| --- | --- |
| 0. Skeleton | Live at https://fantasyscout.beronilla.rodeo/ |
| 1. Ingest | Done: daily landing of the stats API (home runner) and ESPN (GitHub) into the `landing` volume |
| 2. Lakehouse | Done: bronze and silver dbt models pass on DuckDB (CI) and Databricks after every ingest; Asset Bundle job deployed |
| 3. Gold + quality | Built: star schema and marts on both engines, quality checks with severities, `ops.test_results`, publish gate, chaos drill; backfill landing |
| 4. Reconciliation | Done: the stats API and ESPN box scores reconciled per player-game with a review queue (ADR 0005), crosswalks for players, teams and games |
| 5. Serving + app | Done: every build published to R2 behind the Worker (ADR 0006), the Board, Streamers, Trade, player pages, Data Health, Pipeline and Schema pages, the owner's SQL console (ADR 0008) |
| 6. Analysis surfaces | Done: seven notebooks rendered after every full build, the League Pulse Tableau workbook from the extract, the Yahoo league import behind its flag (ADR 0007) |
| 7. AI notes | In progress: the local model beside the home runners (ADR 0017), the weekly notes at `/notes` with their validator and eval (`ai/`, `notes.yml`); claims from the news for the backtest, read by no number (`ai/claims.py`, `claims.yml`, `fct_player_claim`); a daily one-line note on each flagged player, every number and quotation traced (`ai/player_notes.py`, `player-notes.yml`); live answers on the site next |
| 8. Polish | In progress: the milestones of the 2026-11-02 audit (correct data, operable and secure, fast and usable, documented, smarter for the manager); platform hardening (#241 to #296) done and released as v0.8.0 |
