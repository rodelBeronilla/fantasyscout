# Project State — FantasyScout

Last updated: 2026-10-26 (phase 0 rebuilt for the custom domain; first deploy pending)

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
| Preview | `https://fantasyscout-preview.<account>.workers.dev/` | Push to `preprod` (or run "Deploy web" on it) |
| Production | https://fantasyscout.beronilla.rodeo/ (Cloudflare custom domain on Worker `fantasyscout`, ADR 0001) | Push to `main` |

## Active Sprint

Phase 0, Skeleton. Code, CI, docs and ADR 0001 are done; the first deploy needs the Cloudflare secrets in GitHub Actions.

## Milestones

| Milestone | Status |
| --- | --- |
| Phase 0 Skeleton | Built 2026-10-26; deploy pending |
| Phase 1 Ingest | Not started |
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

- `CLOUDFLARE_API_TOKEN` (Workers Scripts edit, R2 edit, and on the `beronilla.rodeo` zone Workers Routes edit + DNS edit) and `CLOUDFLARE_ACCOUNT_ID` must be in GitHub Actions secrets before the first deploy.
- Prerequisites before phase 1: Databricks Free Edition workspace, Tableau Public account.

## Tech Debt

- Local Windows machine lacks the Universal C Runtime that workerd needs; Worker tests run in a container or CI until the VC++ Redistributable is installed.

## Next Actions

1. Owner: add the Cloudflare secrets; confirm Databricks and Tableau accounts.
2. Deploy preview (`preprod`) then production (`main`) per `docs/runbook.md`; confirm `https://fantasyscout.beronilla.rodeo/` serves the placeholder.
3. Phase 1: stats API and ESPN ingestors, landing to the volume, blocked-IP test from a GitHub runner, ADR on where ingestion runs.
