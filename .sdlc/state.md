# Project state: FantasyScout

Last rewritten: 2026-11-17, from scratch (#991). Update it after anything that changes what is in flight, what waits on the owner, or a decision below. History belongs in git, the ADRs and the issues, not here.

Read with it: [pillars.md](pillars.md) for what wins when priorities collide, and [CONTRIBUTING.md](../CONTRIBUTING.md) for how a change is made and checked.

## What this is

A fantasy basketball tool for head-to-head and rotisserie category leagues, NBA and WNBA, at https://fantasyscout.beronilla.rodeo. Its first user is the owner, who plays a Yahoo head-to-head nine-category league of twelve teams. The team punts no category. The platform behind it (ingest, lakehouse, quality gate, serving, backtests) is public in this repository.

## Decisions in force

Recorded here so they are not re-asked. The date is when the owner took them.

- **Merge rule (2026-11-16).** The agent merges docs, fixes and anything a manager cannot see (internal code, or a feature hidden behind a switch) once checks pass. The owner approves anything that changes what a manager sees, any verdict in `methodology/features.yml`, and any credential.
- **The owner's team punts no category (2026-11-16).** An earlier note said it punted points, threes and assists; that was wrong (#925). Punt support (#938) is correctness for leagues that punt, ranked below the owner's own needs.
- **The fallback road (2026-11-16, #989).** Approved once its daily comparison reports differences without opening a `data-incident` issue.
- **Across the two build paths (2026-11-16, #995).** Board values may differ by up to 1e-4 if the board's ranking is identical. Missing rows are not tolerated: each is traced to a cause and fixed. Until then, the comparison reports them.
- **The owner's real league (2026-11-16).** His Yahoo league was imported by bookmark within the week before. He does not punt, and checks that his saved setup has no punts marked.
- **Owner preview (2026-11-16, design in step 3, not built).** Unjudged and failed calls will show to the signed-in owner only, each logged with the call, what he did and what happened. Public pages keep the rule below.
- **Calls need a passed check; data can show (2026-11-09, #936).** A recommendation shows publicly only after its out-of-sample check passes. The same numbers in a labelled, sortable table are data and may show. Switches in `web/src/lib/visibility.ts`; verdicts in `methodology/features.yml`.
- **Board value is validated in season on its error against the naive manager (2026-11-09, ADR 0031).** Preseason value is badged until judged.
- **The production model stays transparent (2026-11-08, ADR 0030).** The machine-learning challenger is a reported benchmark.
- **The morning incident check (2026-11-16).** A cloud task reads the open issues labelled `data-incident` every morning at 7:35 Eastern and pushes them to the owner's phone. Keep that label and the incident titles stable: "Build failure: …", "Ingest failure: …", "Warehouse refuses statements: …", "Publish stale: …".
- **Sources (2026-11-08).** No working around a bot block or a terms restriction; collect politely, stop and delete on objection. Reddit is dropped (ADR 0008 addendum). Nothing holding a source's words is ever a workflow artifact.
- **Owner-only decisions on 2026-11-08** ("choose for me" on fifteen questions) are recorded as comments on each issue: #868, #867, #887, #888, #896, #903, #898, #870, #876, #771, #907, #913.

## The plan (agreed 2026-11-16)

1. **The site cannot go stale unnoticed again, and the repo says how work is chosen.** Done on 2026-11-17, apart from the fallback, which moved to step 2.
2. **The fallback proven for real, and the data at the manager's grain** (player, week, category). No new calls on any page. The fallback merged and a drill publishes through it; #995 traces the missing rows; the morning injury-report redirect is fixed; every page using an imported league says how old its copy is (waits for the owner); `fct_player_week` (#997).
   Not started until the planner specifies them after the owner's feedback: the league-by-category view, the graded card, the owner preview and any study.
3. The owner preview and its log, designed first.

The redesign epic (#936) and the methodology epic (#751) still hold the longer list. Where they conflict with [pillars.md](pillars.md), the pillars win.

## In flight

| Item | Where | Next |
| --- | --- | --- |
| Fallback build | #989; PR #994 | Approved with the drill's change; merging, then one deliberate publish through it. |
| Engine differences | #995 | 12 `fct_event` rows and 2 `fct_market_value` rows to trace; board values within 1e-4 with an identical ranking. |
| Player-week table | #997; branch `ai/feat/997-player-week` | Built and checked on the sample and on real seasons in the Backtest build; the harness reads it unchanged. Owner review; the warehouse path is proved on the first build after merge. |
| Stale copy, Trade's week line, My Team's games left | #939; partial work on `ai/fix/939-stale-copy-week-line` | Pick up after step 1. |

## Waiting on the owner

- Re-registering the host's four ingest tasks with the new action (#985).
- Yahoo's approval of the app for its Fantasy API, which unblocks sign-in (#884).
- Narrower credentials (#424, #425, #426) and branch protection (#432).
- The push keys for alerts, if alerts are built (#876).
- Whether the brand card becomes the image shown when a link is shared.

## How the system runs

| Part | Where | Notes |
| --- | --- | --- |
| Ingest | `ingest.yml`; stats fetches on the home runner (ADR 0002), the rest on GitHub-hosted runners | Started by four Task Scheduler tasks on the host at 04:30, 17:15, 18:45 and 21:15 Eastern (`infra/host/`), with GitHub's crons as the fallback |
| Lakehouse build | `build.yml` on Databricks Free Edition (one SQL warehouse) | Follows each ingest. A light build after a reports-only ingest rebuilds `tag:feed_reports+` and the ops models. |
| Publish gate | `ops.results`, `ops.gate` | Error-severity checks block the export |
| Serving | `fs-export` to R2, a Cloudflare Worker, Astro site | Seven builds kept; rollback by pointer |
| Watchdog | `watchdog.yml`, every six hours | Opens "Publish stale" past 30 hours in season (72 out of season) and "Warehouse refuses statements" |
| Backtests | `backtest.yml` on DuckDB on hosted runners, from a mirror of the landing volume | No warehouse time |
| AI notes | A local model beside the home runner (ADR 0017) | Hidden on the site until their calls are judged (#951) |
| Deploys | `deploy-web.yml` after CI on `main` (production) and `preprod` (preview at https://fantasyscout-preview.rodel-beronilla.workers.dev) | Lighthouse gate: largest paint under 2 s on home and Schema |

The runbook (`docs/runbook.md`) has a section per failure. The architecture and its phase table are in `docs/architecture.md`.

## Coverage

- **Box scores, play-by-play, shots:** NBA 2018-19 to 2026-27, WNBA 2018 to 2026, regular season and playoffs.
- **Official injury reports:** NBA 2023-24 on, WNBA 2026.
- **Observed-only feeds** (ESPN statuses, the fantasy market's ownership, news, props, waiver trends): from late October 2026. They cannot be rebuilt for earlier dates.
- **NBA tracking and hustle:** NBA only; the WNBA host serves none.

## Methodology at a glance

- **Features** (`methodology/features.yml`): 7 validated, 12 failed, 13 open, 4 plain data. Failed and open calls are hidden by switches.
- **Parameters** (`methodology/parameters.yml`): 26 measured, 29 assumed, 12 conventions, 3 arithmetic.
- **Seasons:**
  - tuning: NBA 2020-21 to 2022-23, WNBA 2021 to 2023;
  - judged (spent for every number fitted so far): NBA 2023-24 and 2024-25, WNBA 2024 and 2025;
  - locked for one final judgement: NBA 2025-26, WNBA 2026;
  - live: NBA 2026-27, with week-level judgements due 2027-01-18 and 2027-03-15.
- **Decision records:** ADRs in `docs/adr/` (the index is its README).

## Known debt

- The production build has one road, the warehouse, until #994 merges (#989).
- Light builds run unit tests of models they never build (#956).
- Build warnings that persist (#732).
- Pickups' largest paint is about 3.3 s on a slow phone; reported, not enforced (#563).
- Point-in-time rosters keep retired players (#921).
- Worker tests do not run on the owner's Windows machine (no workerd runtime); CI runs them.

## Outcome measures

Defined in [pillars.md](pillars.md), reviewed every Monday. As of 2026-11-17:

- **Days the owner used the app:** not measured yet. It needs the owner log from step 3.
- **The graded record:** not built yet.
- **Hours since the last published build:** about 135 at the low point (2026-11-16), against a limit of 30. Publishing resumed with build `20261117T003807Z` (NBA data through 2026-11-15), and the four incidents closed.
