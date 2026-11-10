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
| Cloud lakehouse and shared data models | Databricks Free Edition (Unity Catalog, Delta), bronze/silver/gold, star schema | [/schema/](https://fantasyscout.beronilla.rodeo/schema/), [/docs/](https://fantasyscout.beronilla.rodeo/docs/), `docs/architecture.md` |
| Pipelines from third-party APIs | Python ingestors for stats.wnba.com, stats.nba.com and ESPN, landing raw JSON in a volume | `ingest/`, [/pipeline/](https://fantasyscout.beronilla.rodeo/pipeline/), the ingest runs on [/health/](https://fantasyscout.beronilla.rodeo/health/) |
| Large datasets | Play-by-play and shot data for every game since 2018, incremental models, partitioning, Z-ordering | Build runs and their step timings on [/health/](https://fantasyscout.beronilla.rodeo/health/), `docs/adr/0004-stats-api-request-economy.md` |
| Validation, quality checks, alerts | dbt tests, basketball-logic checks, freshness, anomaly checks, alerts on failure | [/health/](https://fantasyscout.beronilla.rodeo/health/), the checks on [/schema/checks/](https://fantasyscout.beronilla.rodeo/schema/checks/) |
| Reconciliation across sources | Stats API vs ESPN box scores per player-game, ID crosswalk, mismatch log | The reconciliation card on [/health/](https://fantasyscout.beronilla.rodeo/health/), `docs/adr/0005-reconciliation.md` |
| Notebooks and dashboards on the same data | Jupyter notebooks over the published build, Tableau Public, in-browser SQL console | [/notebooks/](https://fantasyscout.beronilla.rodeo/notebooks/), [/dashboards/](https://fantasyscout.beronilla.rodeo/dashboards/), [/sql/](https://fantasyscout.beronilla.rodeo/sql/) (the owner's) |
| Products for non-technical readers | Fantasy board, streamers, trade and league tools, player scouting pages | [The Board](https://fantasyscout.beronilla.rodeo/), [/streamers/](https://fantasyscout.beronilla.rodeo/streamers/), [/trade/](https://fantasyscout.beronilla.rodeo/trade/), [/league/](https://fantasyscout.beronilla.rodeo/league/) |
| Documentation of pipelines and definitions | dbt docs site, data dictionary, runbook, ADRs | `docs/` |
| Generative AI, kept honest | Deterministic numbers; a local language model only drafts words, and a validator traces every number in a note to the board's history | `/notes`, `ai/`, ADR 0017 |
| Tracking and event data | Play-by-play events, shot locations, tracking-derived stats where exposed | The shot chart on each player page, `fct_event` and `fct_shot` on [/schema/](https://fantasyscout.beronilla.rodeo/schema/) |

## Status

Built phase by phase; each phase ends with something live and a PR that passes CI. Which phases are done and what is in progress is kept in one place, the [phase table in docs/architecture.md](docs/architecture.md#phase-status); the current sprint and blockers are in [.sdlc/state.md](.sdlc/state.md).

## Repo layout

```
ingest/      Python ingestors, one module per source; CLI: fs-ingest
export/      gold -> Parquet/JSON -> R2, manifest, latest pointer, the Playwright fixture
ops/         results recorder, publish gate, build log, watchdog, schema file for the site's data dictionary
dbt/         dbt project: models/bronze|silver|gold|ops, tests/ (quality checks), seeds/, macros/, sample/
ai/          the weekly notes and the news' claims: inputs, the local model's client, prompts, checks (phase 7)
notebooks/   02_streamer_signals .. 07_teammate_absence as nb_*.py cell sources and committed .ipynb; boxscore.py
tableau/     the League Pulse extract (three CSVs) and the Google Sheet push behind the Tableau Public workbook
web/         Astro app (React islands), Playwright and vitest tests, the committed data fixture
worker/      Cloudflare Worker + wrangler.toml: the site, the data route, the owner's sign-in
infra/       self-hosted runner for the jobs that need a residential address, and the host's daily ingest dispatch
bundles/     Databricks Asset Bundle: jobs, schedules, targets
tests/       Python tests (ingest, export, ops, the fixture contract)
docs/        adr/, runbook.md, architecture.md (the data dictionary is the site's Schema page, from web/src/generated/schema.json)
.github/     workflows: ci, deploy-web, ingest, backfill, build, export, notebooks, probe, query, release, secrets-review, watchdog; composite actions
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

## License

The code and documentation are under the [MIT License](LICENSE). The data the site serves is not: it is derived from the leagues' and the other sources' feeds named on the Sources page and stays theirs, under their terms.

MIT rather than Apache-2.0 (#379): the point is that anyone can read, run and reuse the code with no condition beyond keeping the notice, and the project has no copyleft dependency. Apache-2.0 would add a patent grant and NOTICE handling that the project has no use for.
