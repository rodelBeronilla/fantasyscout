# Project state: FantasyScout

Last rewritten: 2026-11-17, from scratch (#991). Update it after anything that changes what is in flight, what waits on the owner, or a decision below. History belongs in git, the ADRs and the issues, not here.

Read with it: [pillars.md](pillars.md) for what wins when priorities collide, and [CONTRIBUTING.md](../CONTRIBUTING.md) for how a change is made and checked.

## What this is

A fantasy basketball tool for head-to-head and rotisserie category leagues, NBA and WNBA, at https://fantasyscout.beronilla.rodeo. Its first user is the owner, who plays a Yahoo head-to-head nine-category league of eight teams (confirmed 2026-11-17; the facts are under "The owner's league" below). The team punts no category. The platform behind it (ingest, lakehouse, quality gate, serving, backtests) is public in this repository.

## Decisions in force

Recorded here so they are not re-asked. The date is when the owner took them.

- **Merge rule (2026-11-16).** The agent merges docs, fixes and anything a manager cannot see (internal code, or a feature hidden behind a switch) once checks pass. The owner approves anything that changes what a manager sees, any verdict in `methodology/features.yml`, and any credential.
- **The owner's team punts no category (2026-11-16).** An earlier note said it punted points, threes and assists; that was wrong (#925). Punt support (#938) is correctness for leagues that punt, ranked below the owner's own needs.
- **The fallback road (2026-11-16, #989).** Approved once its daily comparison reports differences without opening a `data-incident` issue.
- **Across the two build paths (2026-11-16, #995).** Board values may differ by up to 1e-4 if the board's ranking is identical. Missing rows are not tolerated: each is traced to a cause and fixed. Until then, the comparison reports them.
- **The owner's real league (2026-11-16).** His Yahoo league was imported by bookmark within the week before. He does not punt, and checks that his saved setup has no punts marked.
- **No alerts (2026-11-17).** The owner wants none; #876 is out of the plan.
- **Owner preview (2026-11-16, design in step 3, not built).** Unjudged and failed calls will show to the signed-in owner only, each logged with the call, what he did and what happened. Public pages keep the rule below.
- **Calls need a passed check; data can show (2026-11-09, #936).** A recommendation shows publicly only after its out-of-sample check passes. The same numbers in a labelled, sortable table are data and may show. Switches in `web/src/lib/visibility.ts`; verdicts in `methodology/features.yml`.
- **Board value is validated in season on its error against the naive manager (2026-11-09, ADR 0031).** Preseason value is badged until judged.
- **The production model stays transparent (2026-11-08, ADR 0030).** The machine-learning challenger is a reported benchmark.
- **The morning incident check (2026-11-16).** A cloud task reads the open issues labelled `data-incident` every morning at 7:35 Eastern and pushes them to the owner's phone. Keep that label and the incident titles stable: "Build failure: …", "Ingest failure: …", "Warehouse refuses statements: …", "Publish stale: …".
- **Sources (2026-11-08).** No working around a bot block or a terms restriction; collect politely, stop and delete on objection. Reddit is dropped (ADR 0008 addendum). Nothing holding a source's words is ever a workflow artifact.
- **Owner-only decisions on 2026-11-08** ("choose for me" on fifteen questions) are recorded as comments on each issue: #868, #867, #887, #888, #896, #903, #898, #870, #876, #771, #907, #913.

## The plan (agreed 2026-11-16)

1. **The site cannot go stale unnoticed again, and the repo says how work is chosen.** Done on 2026-11-17, apart from the fallback, which moved to step 2.
2. **The fallback proven for real, and the data at the manager's grain** (player, week, category). Done on 2026-11-17, apart from the import age (PR #1007), which waits for the owner. The fallback published for real and agrees with the warehouse; `fct_player_week` is built on both paths.
   Not started until the planner specifies them after the owner's feedback: the league-by-category view, the graded card, the owner preview and any study.
3. The owner preview and its log, designed first.

The redesign epic (#936) and the methodology epic (#751) still hold the longer list. Where they conflict with [pillars.md](pillars.md), the pillars win.

## In flight

| Item | Where | Next |
| --- | --- | --- |
| The owner's league as Yahoo has it, with the import age folded in | #1022, #1001; PR #1023 | **Waits for the owner** (changes what a manager sees). The import fixes (#1018) merged in #1019. |
| Stale copy, Trade's week line, My Team's games left | #939; partial work on `ai/fix/939-stale-copy-week-line` | Pick up after step 1. |
| The owner's private log (step 3, item 3): pages, imports, calls shown; download and delete under "Your data" | #1032; PR #1033 | **Waits for the owner** (adds a line to the sources page). `logCall` is ready for item 4 and wired to nothing. |

## Waiting on the owner

- Reviewing PR #1023: lineup slots, roster count, score so far, games left, adds, IL moves and the import age (#1022, #1001).
- Adding the new bookmark again and running it on his league.
- Reviewing the stacked PRs #1026 (Yahoo's trade rules on the League page) and #1028 (adds counted since the week's first import), after #1023.
- Reviewing PR #1033, his private log of his own use (#1032).
- Re-registering the host's four ingest tasks with the new action (#985).
- Yahoo's approval of the app for its Fantasy API, which unblocks sign-in (#884).
- Narrower credentials (#424, #425, #426) and branch protection (#432).
- Whether the brand card becomes the image shown when a link is shared.

## The owner's league

Confirmed by the owner on 2026-11-17, every line below. A setup still on the defaults (12 teams, lineup G 3, F 3, C 2, Util 2) was once read as his league, which is where "twelve teams" and the punts came from (#925).

- Yahoo, head-to-head, nine categories, **eight teams**, no punts.
- 13 roster spots: PG, SG, G, SF, PF, F, C, three Util and three bench, plus two IL.
- Playoffs: 6 teams over 3 weeks (Yahoo weeks 18 to 20, 2027-03-01 to 2027-03-21).
- Fantasy weeks run Monday to Sunday; lineups are set daily. Each category counts in the record.
- Four adds a week. A dropped player waits 2 days on waivers. No weekly games cap.
- Trades go to a league vote. The trade deadline and the playoff tie-breaker are read from Yahoo's settings page by the import (#1025), not asked.
- He wants help with all four jobs: the daily lineup, using his adds, reading the matchup, and trades and the league. He decides at all times of day.
- He wants no alerts.
- Besides Yahoo he uses only social media and podcasts.
- His downloaded league file lives outside the repository. It, his team names and his league id are never committed, fixtures included.

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

- The fallback (ADR 0032) builds and publishes from DuckDB when the warehouse refuses; a daily drill compares the two paths and reports any difference without an incident.
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
