# FantasyScout: Basketball Data Platform Spec

## Purpose

FantasyScout is a WNBA-first basketball data platform with a fantasy front end. The fantasy app is what a visitor uses; the pipelines, models, tests and docs behind it are the platform, and all of it is built in public.

It extends an earlier 9-cat draft board: same scoring idea, rebuilt on a proper lakehouse with WNBA as a first-class league.

| Capability | How FantasyScout does it | Where to see it |
| --- | --- | --- |
| Cloud lakehouse and shared data models | Databricks Free Edition (Unity Catalog, Delta), bronze/silver/gold, star schema | Architecture page, dbt docs |
| Pipelines from third-party APIs | Python ingestors for stats.wnba.com, stats.nba.com and ESPN, landing raw JSON in a volume | `ingest/`, run history page |
| Large datasets | Play-by-play and shot data for every game since 2018, incremental models, partitioning, Z-ordering | Performance notes in docs, run timings |
| Validation, quality checks, alerts | dbt tests, basketball-logic checks, freshness, anomaly checks, alerts on failure | Public Data Health page |
| Reconciliation across sources | Stats API vs ESPN box scores per player-game, ID crosswalk, mismatch log | Reconciliation table on Data Health |
| Notebooks and dashboards on the same data | Databricks notebooks, a Jupyter notebook via SQL connector, Tableau Public dashboard, in-browser SQL console | Notebooks and Dashboards pages |
| Products for non-technical readers | Fantasy board, player scouting pages, weekly notes written for a coach or GM | The app itself |
| Documentation of pipelines and definitions | dbt docs site, data dictionary, runbook, ADRs | `/docs` |
| Generative AI, kept honest | Deterministic numbers; an LLM only drafts notes from gold tables, schema-validated and cited | AI page, eval results |
| Engineering hygiene | Lint, tests, dbt build and web build in CI on every PR | This repo |
| Tracking and event data | Play-by-play events, shot locations (x/y), tracking-derived stats where the endpoints expose them | Player shot charts, event models |

## Product

A visitor to `fantasyscout.beronilla.rodeo` can rank WNBA or NBA players for fantasy, open any player's scouting page, and see exactly how fresh and trustworthy the data behind it is. A league toggle (WNBA / NBA) sits in the header; WNBA is the default.

| Page | Path | What it shows |
| --- | --- | --- |
| Board | `/` | Ranked players by category z-score, punt toggles, availability adjustment, filters by team and position |
| Player | `/p/{league}/{player_id}` | Season line, rolling 10-game trends, shot chart from x/y locations, game log, category strengths and drags |
| Streamers | `/streamers` | Next 7 days: games per team, plus players trending up in minutes or usage (NBA in-season; WNBA when its season is live) |
| Scouting notes | `/notes` | Weekly AI-drafted notes, each claim linked to the gold rows behind it |
| Data Health | `/health` | Last run per pipeline, test results, freshness, row counts, reconciliation mismatches |
| SQL console | `/sql` | DuckDB-WASM over exported gold Parquet files; read-only, sample queries provided |
| Dashboards | `/dashboards` | Embedded Tableau Public workbook |
| Notebooks | `/notebooks` | Rendered HTML of the analysis notebooks |
| How it's built | `/about` | Architecture diagram, the capability table above, links to repo and docs |
| Docs | `/docs/` | Generated dbt docs: lineage graph, model and column definitions |

Categories are configurable per league. Defaults: NBA 9-cat (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO). WNBA uses the same nine. Percentages are volume-weighted (makes over attempts), never averaged.

## Architecture

Ingestion runs in GitHub Actions, transformation runs in Databricks, and the public app is a Cloudflare Worker that only ever reads exported gold data. The warehouse is never exposed to the internet, and the whole thing runs at $0/month on free tiers.

A failed check stops the export, so the site keeps serving the last good build while a GitHub issue flags the incident.

| Layer | Choice | Why |
| --- | --- | --- |
| Ingestion | Python 3.12, `httpx`, `nba_api` (league\_id `10` WNBA, `00` NBA), `pydantic` | One ingestor class per source |
| Orchestration | GitHub Actions cron for ingest; Databricks Jobs (Asset Bundles) for transforms | Version-controlled schedules; bundles are how Databricks deployments are meant to be done |
| Landing (bronze) | Unity Catalog volume `fantasyscout.raw.landing`, raw JSON as received | Databricks Free Edition cannot use custom storage locations, so files are pushed in via the Files API |
| Warehouse | Databricks Free Edition: Delta tables, Unity Catalog, 2X-Small SQL warehouse | Free, and the platform the models target |
| Transform | dbt Core with `dbt-databricks`; a second `dbt-duckdb` target for local dev and CI | SQL-first models, tests and docs; DuckDB lets CI run without the cloud |
| Quality | dbt tests, `dbt-expectations`, custom basketball tests, an `ops` schema of results | Every check produces a row someone can query |
| Serving | Nightly export of gold to Parquet + JSON, published to Cloudflare R2 | Static, cheap, fast; warehouse stays private |
| Web app | Astro + React islands, Tailwind, DuckDB-WASM, Observable Plot for charts | Mostly static pages, interactive where it matters |
| Hosting | Cloudflare Worker `fantasyscout` on the custom domain `fantasyscout.beronilla.rodeo` | Edge-served, no shared infrastructure with the main site |
| BI | Tableau Public, embedded | Free public hosting; Power BI Publish-to-web needs a paid licence |
| AI | Anthropic Messages API, current Sonnet-class model, JSON output validated with pydantic | Drafts notes only; see AI usage |

If Databricks Free Edition becomes unavailable or hits its daily quota, the same dbt project builds on DuckDB and the export step reads from there. The site keeps working; the Data Health page shows which engine produced the current build.

## Data sources

The primary source is the league stats API behind stats.wnba.com and stats.nba.com, which share one structure and differ by league ID. ESPN's public JSON is the second source, used for reconciliation and as a fallback. Both are unofficial: respect their terms, throttle hard, and never redistribute raw payloads publicly.

| Source | Endpoints / feeds | Grain | Use |
| --- | --- | --- | --- |
| League stats API (WNBA `10`, NBA `00`) | `leaguegamelog`, `boxscoretraditionalv3`, `boxscoreadvancedv3`, `playbyplayv3`, `shotchartdetail`, `commonallplayers`, `commonteamroster`, `scheduleleaguev2` | Game, player-game, event, shot | Core facts |
| League stats API, tracking-derived | `leaguedashptstats` (speed/distance, touches, drives), `synergyplaytypes` | Player-season | Tracking context; confirm which measures return data for WNBA in phase 1 and document gaps |
| ESPN public JSON | Scoreboard, game summary (box score), team rosters, injuries | Game, player-game | Reconciliation, injury status, fallback |
| Official NBA injury report | Daily PDF during the NBA season | Player-day | Availability; parse with `pdfplumber` |
| Seeds (in repo) | Team metadata incl. Toronto Tempo, ID overrides, category config | Static | Reference data |

**Backfill scope:** WNBA 2018 to 2026 and NBA 2023-24 to current. That is roughly a few million play-by-play events, enough to make incremental loading and partitioning matter.

**Rules for every ingestor**

- One request at a time per host, randomized 1.5–3 s delay, exponential backoff with jitter, max 5 retries.
- Browser-like headers the stats API expects (`Referer`, `Origin`, `User-Agent`, `x-nba-stats-*`).
- Write the raw response untouched to `landing/{source}/{endpoint}/{league}/{season}/{ingest_date}/{key}.json`, plus a sidecar with URL, params, status, bytes, SHA-256 and timestamp.
- Idempotent: a request key already landed with the same hash is skipped. `--full-refresh` and `--since` flags.
- A failed source never fails the run; it logs to `ops.ingest_log`, and downstream uses the last good snapshot.

**Known risk to verify first:** the stats API is reported to block requests from some cloud and CI IP ranges. Phase 1 must test it from a GitHub-hosted runner. If blocked, use one of: a self-hosted runner, a scheduled ingest from a personal machine, or ESPN as the live source with the stats API used for backfill only. Record the decision as an ADR.

## Pipelines and data model

Three layers in one Unity Catalog catalog, `fantasyscout`, each a schema with a clear contract. Every model is a dbt model with a description and tests; nothing in silver or gold is built by hand.

| Schema | Contract | Materialization |
| --- | --- | --- |
| `bronze` | Raw JSON parsed to rows, one table per endpoint, plus `_source_file`, `_ingested_at`, `_payload_hash` | Incremental, append-only, partitioned by `league, season` |
| `silver` | Typed, renamed to snake\_case, deduplicated, one row per natural key, IDs conformed through the crosswalk | Incremental merge on natural key |
| `gold` | Star schema plus fantasy marts; the only layer the app, notebooks and BI read | Tables, rebuilt or merged nightly |
| `ops` | Ingest log, run history, test results, reconciliation results | Append-only |

**Gold star schema**

| Model | Grain | Key columns |
| --- | --- | --- |
| `dim_player` | One row per player (SCD type 2 on team) | `player_sk`, `stats_player_id`, `espn_player_id`, name, position, height, birthdate, `valid_from`, `valid_to` |
| `dim_team` | One row per team-season | `team_sk`, league, abbreviation, name, conference |
| `dim_game` | One row per game | `game_id`, league, season, season\_type, date, home/away team, arena |
| `dim_date` | One row per date | Week, fantasy week, is\_game\_day per league |
| `fct_player_game` | Player × game | Minutes, all box score counts, makes/attempts, plus/minus, `source_agreement` flag |
| `fct_team_game` | Team × game | Team totals, pace, possessions, ratings |
| `fct_event` | One play-by-play event | Period, clock, event type, players involved, score, lineup on floor |
| `fct_shot` | One field goal attempt | `loc_x`, `loc_y`, distance, zone, shot type, made flag, game clock |
| `fct_player_tracking_season` | Player × season × measure | Tracking-derived measures where available |
| `fct_availability` | Player × day | Injury status, source, expected return |

**Fantasy marts:** `mart_player_rolling` (5/10/20-game windows), `mart_category_zscores` (per league, season, window), `mart_board` (total value, punt variants, availability multiplier), `mart_streamers` (games next 7 days, minutes trend).

**Scoring logic** (carried from the earlier draft board, now in SQL): weighted blend of last season (0.55), the season before (0.15) and current season (0.30, rising to 0.8 as games accumulate); z-scores against the top 180 NBA or top 90 WNBA players; turnovers negative; total value × expected games / schedule length.

**Large-data practices:** incremental models keyed on `_ingested_at`, partition pruning by league and season, `OPTIMIZE` + Z-order on `fct_event (game_id)` and `fct_shot (player_id)`, and a docs page showing before/after query timings on the event table.

## Data quality, reconciliation and alerting

A build only publishes to the site if every `error`-severity check passes; `warn` checks publish but show on Data Health. Every check writes a row to `ops.test_results` (check, model, severity, status, failing rows, run\_id), so quality history is queryable, not buried in logs.

| Check | Example | Severity |
| --- | --- | --- |
| Schema and keys | `unique` + `not_null` on every natural key; `relationships` from facts to dims | error |
| Basketball arithmetic | PTS = 2×FGM + FG3M + FTM; FGM ≤ FGA; FG3M ≤ FGM; REB = OREB + DREB | error |
| Box score closure | Sum of player rows = team row for every counting stat | error |
| Minutes closure | Team minutes = 200 (WNBA) or 240 (NBA) + 25 per overtime, within 1 minute | warn |
| Event-to-box agreement | Made shots in `fct_event` per player-game = FGM in `fct_player_game` | warn |
| Shot location sanity | `loc_x`, `loc_y` inside court bounds; 3PT flag consistent with distance and zone | warn |
| Freshness | Latest game in gold within 36 hours of the last scheduled game | error in-season |
| Volume anomaly | Rows per ingest within 3 MAD of the trailing 14-run median | warn |
| Completeness | Every final game on the schedule has a box score and play-by-play | error after 24 h |

**Reconciliation (stats API vs ESPN)**

1. Build `silver.player_xwalk` linking stats API and ESPN player IDs: exact match on normalized name + team + game, then fuzzy name match (Jaro-Winkler ≥ 0.92) with birthdate, then manual overrides from `seeds/player_id_overrides.csv`. Unmatched players go to a review table.
2. Compare every player-game on PTS, REB, AST, STL, BLK, TO, FGM/FGA, FG3M/FG3A, FTM/FTA and minutes.
3. Write differences to `ops.reconciliation` with both values and a resolution rule: stats API wins by default; ESPN wins only where the stats API value is null.
4. Set `fct_player_game.source_agreement` to `exact`, `minor` (minutes only, ≤ 1) or `conflict`. Show the conflict rate per league and season on Data Health.

**Alerts:** on any `error` failure, a failed ingest for two consecutive runs, or freshness breach, the workflow opens or updates a GitHub issue labelled `data-incident` with the failing checks and run link, and sends an email via the GitHub Actions notification. The issue closes itself when the next run passes. Add a Slack or Discord webhook later if wanted (env var, off by default).

## Access layer

Three audiences, three doors onto the same gold tables: people who click (web app, dashboard), people who write SQL (SQL console, Databricks SQL), and people who code (notebooks). No door has its own copy of the logic.

**Export step** (`export/` job, runs after a passing build)

- Writes each gold model to Parquet (zstd) and the small ones also to JSON, under `r2://fantasyscout-data/{build_id}/`.
- Writes `manifest.json` with build\_id, engine (databricks or duckdb), git SHA, row counts, check summary and per-file SHA-256.
- Flips `latest.json` to the new build only after every file uploads. Keeps the last 7 builds for rollback.
- Per-player JSON files for player pages so a page loads one small file, not the whole table.

**Web app**

- Astro static build; React islands for the board, filters and charts.
- Shot charts drawn with Observable Plot on an SVG half-court from `fct_shot` x/y.
- SQL console: DuckDB-WASM loads gold Parquet from R2 over HTTP range requests. Read-only, 10 saved example queries (top usage by minutes, shot zone efficiency, reconciliation conflicts by team).
- Every page footer: data as of, build ID, link to that build's Data Health entry.
- Mobile-first, accessible (axe check in CI), dark and light themes.

**Notebooks** (`notebooks/`)

1. `01_shot_profiles` — zone efficiency vs league average, WNBA 2026.
2. `02_reconciliation_audit` — where and why the two sources disagree.
3. `03_fantasy_value_backtest` — did preseason ranks predict end-of-season value?

Each runs both in Databricks and locally through `databricks-sql-connector` (or DuckDB with `--local`). CI executes them with `nbconvert` against DuckDB and publishes the HTML to `/notebooks`.

**Dashboard:** one Tableau Public workbook, "League Pulse", built from a gold extract: team pace and ratings, player value distribution, data health trend. Embedded on the Dashboards page. Tableau Public needs a manual publish, so the repo includes the export file and a short README for refreshing it; it is the one step that cannot be fully automated.

## AI usage

No number on the site comes from a language model. The LLM writes words about numbers the pipeline already computed, and every claim it makes must point at a gold row that a validator re-checks.

**Weekly scouting notes** (`ai/notes.py`, runs Mondays after the build)

1. Select inputs deterministically: the 15 biggest risers and fallers in `mart_board` over 14 days, availability changes, and minutes or usage shifts beyond 1.5 standard deviations.
2. Send those rows (IDs, values, deltas) to the model with a fixed prompt. Output schema: `{player_id, headline, body ≤ 60 words, claims: [{metric, value, row_ref}], confidence}`.
3. Validate with pydantic. Then re-check every `claims[].value` against the gold row in `row_ref`; any mismatch drops the note and logs it to `ops.ai_rejections`.
4. Publish passing notes with "AI-drafted from FantasyScout data" and links to each referenced row.

**Eval:** a fixed set of 30 historical weeks in `ai/evals/`. CI reports the claim-accuracy rate and rejection rate; the AI page shows both. Target: 100% of published claims verified, rejection rate tracked over time.

**AI in development:** `CONTRIBUTING.md` states that Claude Code was used to build the repo and how it was kept honest: tests written or reviewed before merge, ADRs for every design decision, and no generated code merged without a passing CI run. Commit history should show reviewed PRs, not one giant dump.

## Hosting and deployment

FantasyScout is its own Cloudflare Worker, `fantasyscout`, bound to the custom domain `fantasyscout.beronilla.rodeo`. Cloudflare creates the DNS record and certificate for that subdomain; the main site at `beronilla.rodeo` is served elsewhere and is not touched. See ADR 0001.

**The `fantasyscout` Worker**

- Static assets from Astro's build in `web/dist`.
- `/data/*` streams from an R2 binding (`fantasyscout-data`), honouring `Range` headers for DuckDB-WASM. Same origin, so no CORS setup.
- `latest.json` cached 60 s; build-scoped files cached immutable for a year.
- Security headers: CSP allowing `'wasm-unsafe-eval'` for DuckDB-WASM and `frame-src https://public.tableau.com` for the embed; HSTS, `X-Content-Type-Options`, `Referrer-Policy`.
- Its own 404 page. No secrets in the Worker: it only reads public, exported data.

**Environments**

| Environment | Worker | URL | Deploys on |
| --- | --- | --- | --- |
| Preview | `fantasyscout-preview` | `fantasyscout-preview.<account>.workers.dev` | push to `preprod` |
| Production | `fantasyscout` | `fantasyscout.beronilla.rodeo` | push to `main` |

**Deploys and secrets**

- GitHub Actions deploys the Worker with `wrangler deploy` on merge, and the data export uploads to R2 on each passing build.
- Secrets live only in GitHub Actions secrets: `CLOUDFLARE_API_TOKEN` (scoped to this account: Workers Scripts edit, R2 edit, and on the `beronilla.rodeo` zone Workers Routes edit and DNS edit so the custom domain can be created), `CLOUDFLARE_ACCOUNT_ID`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `ANTHROPIC_API_KEY`. Never in the repo, never in chat.
- The deploy workflow creates the R2 bucket if it is missing. The custom domain is created by the first production deploy.
- Smoke test after every deploy: `/` returns 200 with the app, `/data/latest.json` parses (404 until the first export), one player page renders once players exist.

## Repo layout and engineering standards

One public GitHub repo, `fantasyscout`, readable in five minutes: the README opens with the live link, the architecture diagram and the capability table.

```
fantasyscout/
  ingest/            # Python ingestors, one module per source; CLI: fs-ingest
  dbt/               # dbt project: models/bronze|silver|gold|ops, tests/, seeds/, macros/
  export/            # gold -> Parquet/JSON -> R2, manifest, latest pointer
  ai/                # notes generator, prompts, evals/
  notebooks/         # 01_shot_profiles, 02_reconciliation_audit, 03_fantasy_value_backtest
  web/               # Astro app
  worker/            # Cloudflare Worker + wrangler.toml
  bundles/           # Databricks Asset Bundle: jobs, schedules, targets dev|prod
  dashboards/        # Tableau extract script + publish README
  docs/              # adr/, runbook.md, data-dictionary.md (generated), architecture.md
  .github/workflows/ # ci.yml, ingest.yml, build.yml, deploy-web.yml, notes.yml
```

**Standards**

- Python: `uv` for deps, `ruff` lint and format, `mypy --strict` on `ingest/` and `export/`, `pytest` with recorded fixtures (no live API calls in tests).
- SQL: `sqlfluff` with the dbt templater; every model and column has a description; every gold model has at least a uniqueness and not-null test.
- Web: TypeScript strict, ESLint, Playwright smoke tests, axe accessibility check.
- Git: trunk-based, short PRs, conventional commits, PR template with "what changed / how tested / data impact".
- CI on every PR: lint, unit tests, `dbt build` on DuckDB against fixture data, notebook execution, web build and Playwright run.
- Docs: one ADR per real decision (lakehouse choice, ingestion location, ID resolution strategy, serving pattern). `docs/runbook.md` covers backfill, rerun a day, rotate a key, roll back a build, and what to do when a source changes shape.

## Build phases and acceptance criteria

Each phase ends with something live and a PR that passes CI. Stop and report at the end of every phase rather than run ahead.

| Phase | Delivers | Done when |
| --- | --- | --- |
| 0. Skeleton | Repo, CI, empty Astro app, `fantasyscout` Worker on its custom domain, R2 bucket | `fantasyscout.beronilla.rodeo` shows a placeholder; CI green |
| 1. Ingest | Stats API + ESPN ingestors, landing layout, `ops.ingest_log`, ADR on where ingestion runs | One WNBA 2026 and one current NBA week land from a scheduled run; rerun is a no-op; blocked-IP test result recorded |
| 2. Lakehouse | Databricks catalog and schemas, DAB jobs, dbt bronze and silver, DuckDB target | `dbt build` passes on both engines for the sample; silver keys unique |
| 3. Gold + quality | Star schema, all checks, `ops.test_results`, publish gate, incident issues | Full backfill loaded; zero `error` failures; a deliberately broken fixture opens a `data-incident` issue and blocks publish |
| 4. Reconciliation | Player crosswalk, `ops.reconciliation`, `source_agreement` | ≥ 99% of player-games matched across sources; conflict rate reported per league and season |
| 5. Serving + app | Export, manifest, Board, Player, Streamers, Data Health, SQL console | Pages load from R2 data in under 2 s on 4G (Lighthouse); footer shows build ID; rollback to previous build works |
| 6. Analysis surfaces | Three notebooks, Tableau workbook, dbt docs at `/docs/` | Notebooks execute in CI; dashboard embedded; docs lineage graph live |
| 7. AI notes | Notes generator, validator, evals, AI page | Eval shows 100% verified published claims; rejections logged |
| 8. Polish | README, ADRs, runbook, performance write-up, About page | A stranger can clone, run `make local` on DuckDB and see the app with fixture data |

**Prerequisites before phase 1**

- A Databricks Free Edition workspace with a personal access token. Free Edition limits outbound internet to a fixed set of domains regardless of account verification, so nothing in this design relies on the workspace reaching the internet: ingestion pushes files in through the Files API, and dbt connects to the SQL warehouse from GitHub Actions.
- A Tableau Public account to publish the workbook under.

## References

- [Databricks Free Edition limitations](https://docs.databricks.com/aws/en/getting-started/free-edition-limitations) — serverless only, one 2X-Small SQL warehouse, 5 concurrent job tasks, no custom storage locations, restricted outbound internet, non-commercial use
- [wehoop: WNBA Stats API shot chart](https://search.r-project.org/CRAN/refmans/wehoop/html/wnba_shotchartleaguewide.html) — WNBA league ID `10`, NBA `00`, same endpoint family
- [pbpstats](https://pbpstats.readthedocs.io/en/v1.1.1/) — NBA, WNBA and G-League play-by-play from the stats endpoints
