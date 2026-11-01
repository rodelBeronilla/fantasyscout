# FantasyScout

**Live:** https://fantasyscout.beronilla.rodeo · **Original brief:** [SPEC.md](SPEC.md) · **Architecture:** [docs/architecture.md](docs/architecture.md)

FantasyScout is a WNBA-first basketball data platform with a fantasy front end. The fantasy app is what you use; the pipelines, models, tests and docs behind it are the platform, built in public.

```
sources ─► GitHub Actions ingest ─► Databricks lakehouse (dbt: bronze/silver/gold/ops)
        ─► quality gate ─► export to R2 ─► Cloudflare Worker ─► Astro app, DuckDB-WASM, Tableau, notebooks
```

## What's inside

| Capability | How FantasyScout does it | Where to see it |
| --- | --- | --- |
| Cloud lakehouse and shared data models | Databricks Free Edition (Unity Catalog, Delta), bronze/silver/gold, star schema | Architecture page, dbt docs |
| Pipelines from third-party APIs | Python ingestors for stats.wnba.com, stats.nba.com and ESPN, landing raw JSON in a volume | `ingest/`, run history page |
| Large datasets | Play-by-play and shot data for every game since 2018, incremental models, partitioning, Z-ordering | Performance notes, run timings |
| Validation, quality checks, alerts | dbt tests, basketball-logic checks, freshness, anomaly checks, alerts on failure | Public Data Health page |
| Reconciliation across sources | Stats API vs ESPN box scores per player-game, ID crosswalk, mismatch log | Reconciliation table on Data Health |
| Notebooks and dashboards on the same data | Databricks notebooks, Jupyter via SQL connector, Tableau Public, in-browser SQL console | Notebooks and Dashboards pages |
| Products for non-technical readers | Fantasy board, player scouting pages, weekly notes written for a coach or GM | The app itself |
| Documentation of pipelines and definitions | dbt docs site, data dictionary, runbook, ADRs | `docs/` |
| Generative AI, kept honest | Deterministic numbers; an LLM only drafts notes from gold tables, schema-validated and cited | AI page, eval results |
| Tracking and event data | Play-by-play events, shot locations, tracking-derived stats where exposed | Shot charts, event models |

## Status

Built phase by phase; each phase ends with something live and a PR that passes CI. Phases 0 to 6 are live (ingest, lakehouse, gold and quality, reconciliation, the site, the analysis surfaces); the AI notes of phase 7 wait for the go-ahead. The current state, sprint and blockers are in [.sdlc/state.md](.sdlc/state.md); the phase table in [docs/architecture.md](docs/architecture.md#phase-status).

## Repo layout

```
ingest/      Python ingestors, one module per source; CLI: fs-ingest
export/      gold -> Parquet/JSON -> R2, manifest, latest pointer, the Playwright fixture
ops/         results recorder, publish gate, build log, watchdog, schema file for the site's data dictionary
dbt/         dbt project: models/bronze|silver|gold|ops, tests/ (quality checks), seeds/, macros/, sample/
ai/          notes generator, prompts, evals/ (phase 7: planned, not built)
notebooks/   01_board_backtest .. 07_teammate_absence as nb_*.py cell sources and committed .ipynb; replay.py
tableau/     the League Pulse extract (three CSVs) and the Google Sheet push behind the Tableau Public workbook
web/         Astro app (React islands), Playwright and vitest tests, the committed data fixture
worker/      Cloudflare Worker + wrangler.toml: the site, the data route, the owner's sign-in
infra/       self-hosted runner for the jobs that need a residential address
bundles/     Databricks Asset Bundle: jobs, schedules, targets
tests/       Python tests (ingest, export, ops, the fixture contract)
docs/        adr/, runbook.md, architecture.md (the data dictionary is the site's Schema page, from web/src/generated/schema.json)
.github/     workflows: ci, deploy-web, ingest, backfill, build, export, notebooks, probe, query, watchdog; composite actions
```

## Run it locally

```bash
uv sync --group dbt --group notebooks   # once: the Python groups CI installs (pytest reads the notebooks' pandas)
uv run fs-dev check                      # what CI's Python job runs: ruff, mypy, the dbt sample on DuckDB, pytest
uv run fs-dev check --all                # plus the web suite (astro check, eslint, vitest, build, Playwright) and the Worker's
```

`fs-dev check --list` prints the steps. The web and Worker suites need Node 24 (`npm ci` runs inside them); the Worker's tests need workerd, which on Windows needs the Visual C++ Redistributable (CONTRIBUTING.md).

Full details, including the Windows note about workerd, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Data sources and terms

The site's [Sources page](https://fantasyscout.beronilla.rodeo/sources/) says, per source, what is taken, how often, what is published and how long it is kept, and how a source can object (`web/src/lib/sources.json`).

The league stats API and ESPN's public JSON are unofficial. Requests are throttled hard, raw payloads are never redistributed, and only derived tables are published. Non-commercial use.
