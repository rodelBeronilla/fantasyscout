# Project state: FantasyScout

Last rewritten: 2026-11-17, from scratch (#991); updated 2026-11-22 for step 4's first studies and the backlog push. Update it after anything that changes what is in flight, what waits on the owner, or a decision below. History belongs in git, the ADRs and the issues, not here.

Read with it: [pillars.md](pillars.md) for what wins when priorities collide, and [CONTRIBUTING.md](../CONTRIBUTING.md) for how a change is made and checked.

## What this is

A fantasy basketball tool for head-to-head and rotisserie category leagues, NBA and WNBA, at https://fantasyscout.beronilla.rodeo. Its first user is the owner, who plays a Yahoo head-to-head nine-category league of eight teams (confirmed 2026-11-17; the facts are under "The owner's league" below). The team punts no category. The platform behind it (ingest, lakehouse, quality gate, serving, backtests) is public in this repository.

## Decisions in force

Recorded here so they are not re-asked. The date is when the owner took them.

- **Merge rule (2026-11-21, replaces the rule of 2026-11-16).** The owner no longer approves pull requests. The agent reviews and merges on its own evidence.
  - **Docs, fixes and anything a manager cannot see** (internal code, or a feature behind a switch) merge once every check is green.
  - **A change that alters what a manager sees, or a verdict in `methodology/features.yml`,** merges when all of these hold:
    1. Its bar was written on the issue before the work started.
    2. Every check is green: CI, the security scan, accessibility, the speed budget.
    3. A fresh sub-agent that did not write the change has reviewed it, given only the issue's bar, the diff and the preview, on the most capable model available. Its job is to break the change: it checks each line of the bar against evidence it gathers itself; runs the change on the preview with the owner's real league file from `private/`, and compares with Yahoo through the browser where that applies; and looks for the faults the owner has found so far (numbers shown without saying what they are, facts wrong for his league, advice he cannot follow, anything dropped silently). It writes approve or block, with reasons, on the pull request. The author cannot overrule a block: fix and ask for review again. A second block on the same point: write its root cause, take a different approach, and have a new review agent review it. A third block on the same point: park the pull request, put it in Monday's digest with a recommendation, and move to other work (owner, 2026-11-21).
    4. The review agent has confirmed how to undo it: a switch, or one revert.
    5. A verdict changes only when its pre-declared test passed its bar and the review agent reproduced the number.
  - **After merging,** the agent checks the live page against the bar itself. If it fails: revert first, fix after.
  - **Still the owner's, always.** Stop and ask before any secret, credential or paid service; anything sent to a person or posted outside this site and repository; deleting his data or his log; any change outside this repository, or to this rule.
  - **His real league data never goes into a sub-agent's brief or a test** (owner, 2026-11-21): a brief points to the file in `private/` by its path, and tests use invented data written by hand.
  - **His real Yahoo pages are never committed, scrubbed or not.** They stay in `private/`; the tests that need them run locally; only fixtures written by hand to match their structure are committed. No fixture needs his approval.
  - **Visibility in place of approval.** Every Monday the agent writes him one short digest in `.sdlc/digests/<date>.md`: what merged, each review's verdict in a line, anything reverted, and what he would notice on the site. He reads it; he does not sign it.
  - **His own feedback from using the app stays the top of the backlog.**
- **The capture is dropped (2026-11-21).** Item 1 was verified against his live Yahoo pages, and his real pages are never committed. The capture bookmark stays as a feature.
- **Two early commits on a deleted branch (2026-11-21).** `2539561` and `6842b68`, from PR #1053, are no longer on any branch but GitHub still serves them by hash. `2539561` holds one matchup's totals from his league (two rows of numbers under invented team names); neither holds a team name, a manager name or his league id. Numbers only, so they are recorded here and left.
- **The owner's team punts no category (2026-11-16).** An earlier note said it punted points, threes and assists; that was wrong (#925). Punt support (#938) is correctness for leagues that punt, ranked below the owner's own needs.
- **The fallback road (2026-11-16, #989).** Approved once its daily comparison reports differences without opening a `data-incident` issue.
- **Across the two build paths (2026-11-16, #995).** Board values may differ by up to 1e-4 if the board's ranking is identical. Missing rows are not tolerated: each is traced to a cause and fixed. Until then, the comparison reports them.
- **The owner's real league (2026-11-16).** His Yahoo league was imported by bookmark within the week before. He does not punt, and checks that his saved setup has no punts marked.
- **No alerts (2026-11-17).** The owner wants none; #876 is out of the plan.
- **The owner's log and Yahoo (2026-11-17).** His private log of his own use is kept until he deletes it, and the sources page says so. The extra owner-status check per page and a rare lost log event are accepted. No Yahoo credentials are stored or used by any agent, ever. Any fixture built from his real pages waits for his approval before it is committed.
- **The owner's browser (2026-11-17).** Every chat gets browser tools that act in his own Chrome. The rules for using his browser are in [AGENTS.md](../AGENTS.md). No Yahoo hand-off starts without his request.
- **The default league stays the WNBA (2026-11-17).** Not to be reopened; a first visit on the WNBA is told that imports are for NBA leagues (#1037).
- **The week-by-week design is kept (2026-11-17).** The owner saw the draft and likes it; it is polished after item 1, and the draft page stays out of the preview's sitemap.
- **One instructions file (2026-11-18).** `AGENTS.md` is the only file of project instructions for agents; no other is added.
- **All-play counts categories (2026-11-17).** A week's all-play record is each category against each other team: 63 results a week in his league.
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
3. **The owner's league, week by week** (started 2026-11-17). Merged after review: #1048, #1053 (item 1), #1055 (item 2), #1071, #1072, #1074. Item 4, the owner preview (#1057), is parked after three blocks on one point (what the frames say about the adds), with a recommendation for the owner's digest; item 5 (#1059) and the expected categories won (#1073) wait for it.
4. **Step 4, the first studies** (started 2026-11-21): predict a player's week, by category, better than the projection does. S0, the yardstick (#1077), sets every bar: a quarter of its recorded noise per category, and no category worse. Then S1 games played (#1079), S2 minutes when a teammate is out (#1080), S3 opportunity before outcome (#1081), S4 shot diet (#1082), two sub-agents at a time. A pass feeds the existing calls in the owner preview, labelled, logged and graded each Monday, and shows publicly only after six live weeks agree; a fail is recorded in features.yml and ADR 0012 and not retried. One page per study in docs/analysis. Declared now for the next round, so it is not added later: per-category opponent strength over the week. First round done on 2026-11-22: S0 set the bars (#1078, #1084); S1 passed in the NBA and is open, waiting on 2026-27's live weeks, and failed in the WNBA (#1086); S2 (#1093), S3 (#1092) and S4 (#1085) failed. Judged numbers sit in features.yml's `result` field, off the public table (#1091).

The redesign epic (#936) and the methodology epic (#751) still hold the longer list. Where they conflict with [pillars.md](pillars.md), the pillars win.

## In flight

**The backlog push (owner, 2026-11-22): every open issue and pull request is finished, closed with its reason, or says what it waits on.** Each was triaged from its issue, the code and the registry on 2026-11-22. Workers are sub-agents on a lane each, two lanes at a time (pillars), one item per branch, each item's bar on its issue first. A change a manager sees is reviewed by a fresh review agent before it merges; the preview holds one such change at a time. Backtest runs go one at a time.

| Lane | Items, in order | State |
| --- | --- | --- |
| Owner preview (step 3) | #1057 (the adds line repeats the tile's wording; fourth review), #1059, #1073, the rest of #1065 | Running. The owner's instruction of 2026-11-22 is the go on #1057's recommendation. |
| Data and builds | #956, then #732's warnings (venues, game lines, the listing relationship, minutes closure, reconciliation), #921 | Running. |
| Yahoo bookmark | #1052, #1050, #1047, #1063, #1062, #1069, #489 | Next. One file (`yahoo-bookmarklet.ts`), so strictly one after another. |
| League page and phone | #1075, #1064, #1076 | Queued. |
| Web correctness | #939 (redone alone on main), #672 (games in the playoff weeks, data only), #938, #925, #495 (facts only) | Queued after the bookmark lane's My Team changes. #938's only copy is local commit `d7d6142` in the worktree `agent-a55328c72c16301a9`; #925's is 16 uncommitted files in `agent-a481c2433245b888f`. Neither worktree is removed until salvaged. |
| Studies harness (step 4) | #1087, #1088, #1090, then the wording in #1089 and #1094 | Queued. |
| Dependencies | The twelve Dependabot pull requests (#730 to #1017); #842 fails its Python checks | Queued. |
| Bars and gates | Bars for #754, #761, #867 (NBA), the pooled playoff odds (#907, #913, #898), #886, #888, #904, #772, #916, #915; the first-game gates of #898 and #913; #867's WNBA switch | Queued. A bar missed now misses the one locked-season run (#769). |
| Trade reworks | #886 (six tuning Backtest runs), then #888, #904 | Queued after the bars. |
| Live-week judge | #1096, built on invented weeks before the first look on 2027-01-18 | Queued. Eight calls and S1's NBA rule (#1079) are judged by it. |
| Speed on a phone | #563, then #557 | Queued. |
| Removals decided on 2026-11-08 | #868 (Fit), #887 (suggested trades), #903 (sell high), #896 (trade chips) | Held for one answer: the owner preview would show these failed calls to him, and removing them takes them out of it. Stale local work for #868 and #887 is in `agent-a1065c8b744e1b165` and `agent-a451ab15c2cba0a66`. |
| New study | #772 contract year, after per-category opponent strength (declared 2026-11-21, no issue yet) | Queued last. |

**The warehouse is down (#1043, #1044).** Databricks has refused to start the SQL warehouse since 2026-11-20 ("Cannot create the resource"). The fallback job builds on DuckDB and publishes after every ingest, so the site is current; the notes runs after each build are skipped, and nothing can be measured on the warehouse (#447). Bringing it back is done in the workspace, which is the owner's.

**Waiting, each with a status comment of 2026-11-22 saying on what:** 2026-27's weeks at the looks of 2027-01-18 and 2027-03-15 (#759, #762, #763, #770, #895, #950, #951); the one locked-season run (#769); the season's end (#754, #915, #916); later seasons (#491, #517, #760); a season of claims (#812); another issue (#810); the epics #751 and #936. S1's NBA rule (#1079) waits on the same weeks.

**Closed on 2026-11-22:** #673, #766 and #926 as done; #139, #675 and #734 as not planned (a bot block; calls that failed or are unjudged; the pillars' non-goal of matching every paid tool).

## Waiting on the owner

- **Bringing the warehouse back** (#1043, #1044): start or recreate it in the Databricks workspace and set `DATABRICKS_WAREHOUSE_ID`, or say an agent may.
- **The removals of 2026-11-08 against the owner preview** (#868, #887, #896, #903): remove as decided (recommended), or keep them for his preview.
- **The "too close" label on the matchup card** (#902): no replay can fit a definition. Retire it and show each category's projected edge (recommended), or name a band.
- **RSS feeds whose terms bar AI use** (#924): the issue says he extended the ESPN exception; the Sources decision below says no terms restriction is worked around. Recommended: close as not planned.
- **Branch protection** (#432): enforce admins with a second approval, or record that review is the review agent's comment plus the required checks (recommended; the merge helper merges as admin and resets `preprod`).
- Narrower credentials (#424, #425, #426): he creates the principal, the tokens and the environment secrets; the workflow changes follow.
- Re-registering the host's four ingest tasks with the new action (#985).
- Yahoo's approval of the app for its Fantasy API, which unblocks sign-in (#884).
- Whether the brand card becomes the image shown when a link is shared.
- From the digest of 2026-11-23: whether S1's live confirmation must also beat a flat discount; whether a judged number kept in `result`, off the public table, is how he wants a fail "recorded with the number".
- Whether the two-lanes-at-a-time limit is raised for the backlog push.

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

- **Features** (`methodology/features.yml`): 7 validated, 16 failed, 14 open, 4 plain data. Failed and open calls are hidden by switches. S4, the shot diet (#1082), failed on 2026-11-21 and was never built. S3, opportunity before outcome (#1081, NBA only), failed in all four targets on 2026-11-22 and was never built. S2, minutes when a teammate is out (#1080), failed in both leagues on 2026-11-22 and was never built.
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
- Worker tests do not run on the owner's Windows machine (no workerd runtime); CI runs them.

## Outcome measures

Defined in [pillars.md](pillars.md), reviewed every Monday. As of 2026-11-17:

- **Days the owner used the app:** not measured yet. It needs the owner log from step 3.
- **The graded record:** not built yet.
- **Hours since the last published build:** about 135 at the low point (2026-11-16), against a limit of 30. Publishing resumed with build `20261117T003807Z` (NBA data through 2026-11-15), and the four incidents closed.
