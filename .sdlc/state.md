# Project State — FantasyScout

Last updated: 2026-10-26 (phase 0 live)

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

Phase 0, Skeleton, is live (PR #2 merged 2026-10-26, issue #1): placeholder at https://fantasyscout.beronilla.rodeo/, preview Worker deployed from `preprod`, R2 bucket bound. Waiting for the owner's go-ahead for phase 1.

## Milestones

| Milestone | Status |
| --- | --- |
| Phase 0 Skeleton | Done 2026-10-26 (live, CI green) |
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

- Prerequisites before phase 1: Databricks Free Edition workspace, Tableau Public account.

## Tech Debt

- Local Windows machine lacks the Universal C Runtime that workerd needs; Worker tests run in a container or CI until the VC++ Redistributable is installed.

## Next Actions

1. Owner: confirm Databricks and Tableau accounts and give the go-ahead for phase 1.
2. Phase 1: stats API and ESPN ingestors, landing to the volume, blocked-IP test from a GitHub runner, ADR on where ingestion runs.
