# Project State — FantasyScout

Last updated: 2026-10-27 (phase 1 live: scheduled ingest from GitHub and the home runner)

## Vision

A WNBA-first basketball data platform with a fantasy front end, built in public. The app is what people use; the pipelines, models, tests and docs behind it are the platform. Source of truth: `SPEC.md`.

## Stack

Python 3.12 + uv (ingest, export, AI), dbt Core on Databricks Free Edition with a DuckDB target for CI, Astro + Tailwind web app, Cloudflare Worker + R2 for serving on `fantasyscout.beronilla.rodeo`, GitHub Actions for CI and deploys, Tableau Public for BI.

## Commands

| Command | Description |
| --- | --- |
| `uv run ruff check . && uv run mypy && uv run pytest` | Python checks |
| `cd web && npm run check && npm run lint && npm run build && npm test` | Web checks and Playwright |
| `cd worker && npm run typecheck && npm test && npm run check` | Worker checks and dry-run deploys |

## Deployment

| Environment | URL | Trigger |
| --- | --- | --- |
| Preview | https://fantasyscout-preview.rodel-beronilla.workers.dev/ | Push to `preprod` (or run "Deploy web" on it) |
| Production | https://fantasyscout.beronilla.rodeo/ (Cloudflare custom domain on Worker `fantasyscout`, ADR 0001) | Push to `main` |

## Active Sprint

Phase 1, Ingest (issue #7, PR #8). Throttled client, stats API and ESPN ingestors, landing store with idempotent index, `fs-ingest land`, scheduled `ingest.yml` with incident issues. Probe showed the stats API does not answer GitHub-hosted runners (ADR 0002, decision pending); ESPN and Databricks do. A full WNBA week landed locally with zero failures and a no-op rerun.

## Milestones

| Milestone | Status |
| --- | --- |
| Phase 0 Skeleton | Done 2026-10-26 (live, CI green) |
| Phase 1 Ingest | In progress (2026-10-27): code done, ESPN scheduled from GitHub; stats API needs a residential runner (ADR 0002) |
| Phase 2 Lakehouse | Not started |
| Phase 3 Gold + quality | Not started |
| Phase 4 Reconciliation | Not started |
| Phase 5 Serving + app | Not started |
| Phase 6 Analysis surfaces | Not started |
| Phase 7 AI notes | Not started |
| Phase 8 Polish | Not started |

## Velocity

N/A, first sprint.

## Blockers

- Tableau Public account exists; needed in phase 6.

## Tech Debt

- Local Windows machine lacks the Universal C Runtime that workerd needs; Worker tests run in a container or CI until the VC++ Redistributable is installed.

## Next Actions

1. Phase 1 close-out: confirm the first scheduled (cron) run is green and the incident issues stay closed.
2. Phase 2: Databricks catalog and schemas, Asset Bundle jobs, dbt bronze and silver, DuckDB target.
