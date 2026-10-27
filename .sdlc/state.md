# Project State — FantasyScout

Last updated: 2026-10-27 (phase 4 done; waiting for the go-ahead for phase 5)

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
| `cd dbt && DBT_PROFILES_DIR=. uv run dbt build --target duckdb` | Lakehouse models and tests on the fixture sample |

## Deployment

| Environment | URL | Trigger |
| --- | --- | --- |
| Preview | https://fantasyscout-preview.rodel-beronilla.workers.dev/ | Push to `preprod` (or run "Deploy web" on it) |
| Production | https://fantasyscout.beronilla.rodeo/ (Cloudflare custom domain on Worker `fantasyscout`, ADR 0001) | Push to `main` |

## Active Sprint

Phase 4, Reconciliation (issue #51): three crosswalks in silver (`team_xwalk`, `game_xwalk`, `player_xwalk` with exact, fuzzy-with-birthdate and override passes, plus `player_xwalk_review`), `player_game_reconciliation`, `ops.reconciliation` (differences with the resolution rule) and `ops.reconciliation_summary` (match and conflict rates per league and season, printed in every build log), `fct_player_game.source_agreement` and resolved values, `dim_player.espn_player_id`, a warn-severity coverage check, ADR 0005. Full backfill on Databricks (build 40547678267): 156,899 box-score lines, 99.5% matched, every season at or above 99.3% of played player-games, every conflict rate at or below 0.21%, 244 checks pass with no warning; a read-only "Query the lakehouse" workflow prints any table into a job log. Evidence on issue #51. Waiting for the owner's go-ahead for phase 5.

Phase 3, Gold + quality, is done (issue #22; PRs #23 to #48). Gold star schema and fantasy marts, quality checks with the spec's severities, `ops.test_results` and `ops.publish_gate` written after every build, failing-row samples in the gate output and the incident comment. The full backfill landed on the two home runners (WNBA 2018 to 2026, NBA 2023-24 to 2026-27) and build 40533318734 passed 195 of 195 checks with the gate open; incident #25 closed itself. Chaos drill: run 40534274422 (chaos input) blocked the gate and opened an incident, run 40535051516 passed and closed it. Waiting for the owner's go-ahead for phase 4.

What the backfill taught (all fixed, recorded in ADR 0004 and the runbook): the stats hosts' bot-manager cookies stall a long-lived client, so the client drops cookies before every request and backfills time out reads at 20 s; bronze's incremental filter skipped same-day landings; the gate step never received the warehouse id; the Files API rate-limits write bursts (retried now); neutral-site games list both teams as home; the schedule carries preseason games the platform does not ingest (`game_type` scopes the checks); WNBA playoffs can start in August.

Phase 2, Lakehouse, is done (issue #16; PRs #17, #19 and the bundle PR): 15 bronze and 13 silver dbt models with 83 tests pass on DuckDB in CI and on Databricks after every ingest. Waiting for the owner's go-ahead for phase 3.

Phase 1, Ingest, is done (issue #7; PRs #8, #9, #10, #13, #14). Daily `ingest.yml` lands ESPN from GitHub-hosted runners and the stats API from the home runner into `fantasyscout.raw.landing`. First runs landed a WNBA week (25 games, 115 payloads) and an NBA week (49 games, 229 payloads) with zero failures; the rerun skipped all 118 WNBA payloads without a request. Incident issues open and close themselves. Waiting for the owner's go-ahead for phase 2.

## Milestones

| Milestone | Status |
| --- | --- |
| Phase 0 Skeleton | Done 2026-10-26 (live, CI green) |
| Phase 1 Ingest | Done 2026-10-27 (both sources landing daily; ADR 0002 accepted) |
| Phase 2 Lakehouse | Done 2026-10-27 (issue #16): dbt build PASS=114 on DuckDB (CI) and Databricks; Asset Bundle job deployed paused |
| Phase 3 Gold + quality | Done 2026-10-27 (issue #22): star schema, marts, checks, results table, gate; full backfill loaded, 195 checks pass on Databricks, chaos drill proven |
| Phase 4 Reconciliation | Done 2026-10-27 (issue #51): crosswalks, ops.reconciliation, summary per league and season, source_agreement; 99.5% matched, every season ≥ 99.3% played; ADR 0005 |
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

1. Owner: go-ahead for phase 5 (export to R2, manifest, Board, Player, Streamers, Data Health and SQL console pages).
2. Watch the nightly build log's reconciliation summary; any season under 99% matched warns, and `silver.player_xwalk_review` names the players to add to the overrides seed.
3. Deferred from phase 3: lineup columns in `fct_event`, tracking facts, a performance timings page, an ESPN core-API fallback if summary coverage ever drops below 99%.
