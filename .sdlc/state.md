# Project State — FantasyScout

Last updated: 2026-10-27 (phase 1 done)

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

Phase 1, Ingest, is done (issue #7; PRs #8, #9, #10, #13, #14). Daily `ingest.yml` lands ESPN from GitHub-hosted runners and the stats API from the home runner into `fantasyscout.raw.landing`. First runs landed a WNBA week (25 games, 115 payloads) and an NBA week (49 games, 229 payloads) with zero failures; the rerun skipped all 118 WNBA payloads without a request. Incident issues open and close themselves. Waiting for the owner's go-ahead for phase 2.

## Milestones

| Milestone | Status |
| --- | --- |
| Phase 0 Skeleton | Done 2026-10-26 (live, CI green) |
| Phase 1 Ingest | Done 2026-10-27 (both sources landing daily; ADR 0002 accepted) |
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

- None. Tableau Public account exists; needed in phase 6.

## Tech Debt

- Local Windows machine lacks the Universal C Runtime that workerd needs; Worker tests run in a container or CI until the VC++ Redistributable is installed.

## Next Actions

1. Owner: go-ahead for phase 2.
2. Watch the first cron run (09:15 UTC) stay green.
3. Phase 2: Databricks catalog and schemas, Asset Bundle jobs, dbt bronze and silver, DuckDB target.
