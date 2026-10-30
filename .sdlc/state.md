# Project State — FantasyScout

Last updated: 2026-10-30 (data used everywhere, accurate schema and pipeline pages, notebooks that test the board; phase 7 still waits for the go-ahead)

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

Data, documentation and analysis (issues #163 to #193), 2026-10-30. Four read-only audits (data usage, schema page, pipeline page, notebooks) drove the work.

- **Correctness**: every gold date cut-off is Eastern (#164); the Board's vs Mkt follows the league's settings; the daily stats ingest now lands playoff games too (#184; the WNBA Finals had blocked the gate); WNBA and NBA ESPN transaction lines link to the players they name (#180).
- **Freshness and history**: `ops.feed_freshness` + `warn_stale_feeds` + a Data Health table (its first run caught standings never landing); `gold.fct_board_history`, a daily ledger that survives full refreshes, so the newer signals can be backtested; `gold.fct_game_line` (#168).
- **Signals everywhere** (#170, #174, #178, #190): the player page shows the outlook and next games; headline flags, injury detail, lineup day, fantasy-week games and an ESPN ownership trend (the WNBA's waiver signal) on Board and Streamers; Streamers follow the league's scoring and size, and sort by last-ten production x games, which the streamer notebook found twice as good as the minutes trend.
- **Schema** (#172, #176): every silver, gold and ops column described, enforced in CI (`ops.schema --require-docs`); the schema page has subject-area ER diagrams, lineage from the landing zone, grain, readers, unit tests, a filter and coverage badges.
- **Pipeline page** (#187): rewritten against the code, two-part diagrams that fit, one stage numbering, counts from the schema file.
- **Notebooks** (#185): board backtest (point-in-time replay of the projection, parity with the build), streamer signals, game context, data quality scorecard, shooting stability. `notebooks.yml` runs a branch's notebooks against the published build before merging (#166).
- **Open from the notebooks**: availability multiplier for short absences (#192).
- **NBA value spread** (#193): the 0.55 slope was the measure (below-replacement values scaled by games in the target, not on the board); per game both leagues are 0.82. Priors, minutes, durability, recency and value factors replayed; no model change (ADR 0003 addendum). The notebook now fits the slope above replacement and per game.

Data sources and in-season signals (issues #124 to #143 and #129), 2026-10-29 to 2026-10-30. Each source lands in the reports run (`fs-ingest land reports`, GitHub-hosted, mornings and 7 pm ET), is modelled bronze to gold, and is credited in the footer.

- **Official injury reports** (#128): the leagues' PDFs parsed to `fct_player_status`. They win for the next game; the rest-of-season multiplier still reads ESPN.
- **Starting lineups and transactions** (#140): NBA Expected and Confirmed lineups (`fct_starting_lineup`), and the NBA movement feed plus ESPN transactions (`fct_transaction`). Dates follow `eastern_today()`.
- **Betting lines** (#127): ESPN odds give implied team points on Streamers.
- **Rest, travel and altitude** (#126): `fct_team_game_context`, with undecided cup games left out.
- **Playoff stakes and rest risk** (#141): `fct_team_stakes`.
- **ESPN fantasy market** (#142): `fct_market_value`, ranks and ownership buckets only.
- **In-season minutes** (#124): blended 50/50 with the last five games (backtest: NBA MAE 3.98 to 3.44).
- **Positional defence**: tested and not built (ADR 0003).
- **ESPN headlines** (#143, PR #157): `fct_player_news` with headline flags, headline and link only, on the player page.
- **Sleeper waiver heat** (#129, PR #158): `fct_waiver_trend`, NBA, on Streamers, linked by name, birth date and team.
- Yahoo import parked as "coming soon"; the owner signs in to the SQL console with Yahoo OpenID (ADR 0008).

League tools (issues #110, #111; PRs #112 and the Yahoo PR), 2026-10-29.

- **League page.** `/league/` holds the manager's league in the browser (`fantasyscout:league:<league>`): settings, teams in draft order and their rosters. Rosters fill by search, by paste or by a snake draft with undo, and a team strength table compares the teams. A league file saves and loads it.
- **Board.**
  - It reads the league: Available, My team or Everyone; owner tags; Fit; a Draft button during a draft.
  - Its secondary filters sit behind a Filters button, with removable chips for the active ones.
  - Tiers are Jenks natural breaks over the rostered pool, one per roster spot, labelled with their picks, rounds, values and how many players are still available.
- **Yahoo import (ADR 0007).** The Worker signs the manager in to Yahoo and reads their NBA leagues. Tokens stay in an encrypted HttpOnly cookie. The import is off until the owner registers a Yahoo app and adds `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET` (runbook: "Turn on the Yahoo league import").

Earlier the same day: manager board (#107, PRs #108, #109); staged hand exports (#105, #106); documentation audit gaps (#104); projection context (#103).

Board rework and documentation (issues #80, #82, #83, #85; PRs #81, #84, #86, #87), 2026-10-29. The board lists only players on each team's latest roster and values them above replacement from one projected line per player: per-minute production (seasons weighted by minutes and recency) times projected minutes, from a replacement-level prior, scored in two passes against a fantasy league's rostered pool, and counted over the projected share of regular-season games played. The settings (`fantasy`, `fantasy_recency`, `fantasy_durability` vars) were chosen by backtest; results in ADR 0003. `/pipeline/` draws the design end to end with the methods per stage, and `/schema/` lists every model, column, type and test from `web/src/generated/schema.json` (regenerate with `dbt docs generate` and `python -m ops.schema`; CI checks it). Deploys gate on the median of three Lighthouse runs, with the stylesheet inlined (median LCP about 0.9 s). Live data build 20261029T052437Z-f03e5ae, 271 checks pass.

Issue #72, fixes to the phase 3 to 6 surfaces, is done (PRs #73 to #78). Injuries now link to players (via the ESPN roster or by name within the team), board values account for availability and rest of season (regular-season games only), plus-minus and positions are real, the board has blend, last-ten and per-game views with sorting, position eligibility and injury tags, Streamers has a week grid and trend-based candidates, and the notebooks page shows each notebook's findings for both leagues. `silver.event_lineups` puts five a side on the floor for every play-by-play action; after the name-matching fixes every season passes the 90% check (NBA 98.6% to 99.3%, WNBA 2020 to 2026 at least 99.1%, WNBA 2018 and 2019 93.5% and 94.8%). Live site verified headless on both leagues, desktop and phone: no console errors, no sideways scroll.

Phase 6, Analysis surfaces, is done (issue #66). dbt docs with the lineage graph are generated at deploy time and live at `/docs/` under their own policy. The analysis notebooks (now five: `01_board_backtest`, `02_streamer_signals`, `03_game_context`, `04_data_quality`, `05_shooting`) read the published build, the local DuckDB file or the lakehouse through one helper; CI executes them against the sample on every pull request, and the build workflow executes them against every published build and renders them under it at `/notebooks/`. The League Pulse workbook's extract (`tableau/extract.py`: team pace and ratings, player value, data health) is refreshed and published with every build and linked from `/dashboards/`, which embeds the Tableau Public workbook once the owner has published it and set the `TABLEAU_VIZ_URL` repository variable (the one manual step, documented in `tableau/README.md`). Waiting for the owner's go-ahead for phase 7.

Phase 5, Serving + app, is done (issue #58; PRs #59, #60, #61 and the close-out). `fs-export` publishes a data build to R2 after every passing gate (ADR 0006): Parquet and JSON per gold model, the big facts per league-season, per-league board and streamers, `health.json`, one file per player, a manifest, `latest.json` flipped last, seven builds kept, rollback by pointer. The site reads it: Board (punt toggles, availability adjustment, filters), Player (season lines, rolling trend, shot chart with league zone averages, category strengths, game log with the reconciliation verdict), Streamers, Data Health, SQL console (DuckDB-WASM over the Parquet files, ten saved queries), league and theme toggles, footer with the data build id. Lighthouse on the production home page: performance 99, LCP 1641 ms, TTI 1641 ms (mobile, simulated slow 4G). Live data build at close-out: 20261027T222649Z-4320e65. Waiting for the owner's go-ahead for phase 6.

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
| Phase 5 Serving + app | Done 2026-10-27 (issue #58): export to R2 with manifest and rollback, Board, Player, Streamers, Data Health, SQL console, Lighthouse budget in the deploy |
| Phase 6 Analysis surfaces | Done 2026-10-28 (issue #66): dbt docs at /docs/, notebooks executed in CI and on every build at /notebooks/, Tableau extract and Dashboards page (manual publish pending) |
| Phase 7 AI notes | Not started |
| Phase 8 Polish | Not started |

## Velocity

N/A, first sprint.

## Blockers

- None. Tableau Public account exists; needed in phase 6.

## Tech Debt

- Local Windows machine lacks the Universal C Runtime that workerd needs; Worker tests run in a container or CI until the VC++ Redistributable is installed.

## Next Actions

1. Owner: the Google Sheets bridge setup in tableau/README.md (service account secret `GOOGLE_SERVICE_ACCOUNT_JSON`, sheet shared with it, variable `TABLEAU_SHEET_ID`), then publish the League Pulse workbook from that sheet and set `TABLEAU_VIZ_URL`; then go-ahead for phase 7 (AI scouting notes with verified claims).
2. Watch the nightly build log's reconciliation summary; any season under 99% matched warns, and `silver.player_xwalk_review` names the players to add to the overrides seed.
3. Owner, optional: the Yahoo app exists and its secrets are deployed (2026-10-29), but Yahoo answers 403 until it approves Fantasy Sports API access. Apply at https://sports.yahoo.com/developer/access/, sign the DocuSign agreement, then submit the Client ID at https://sports.yahoo.com/developer/application-confirmation/ (runbook). Earlier note: register a Yahoo developer app (redirect URI https://fantasyscout.beronilla.rodeo/auth/yahoo/callback, Fantasy Sports read) and add the `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET` Actions secrets to turn on the Yahoo league import; then sign in on the League page (NBA) to verify it end to end.
4. Deferred from phase 3: tracking facts, a performance timings page, an ESPN core-API fallback if summary coverage ever drops below 99%.
