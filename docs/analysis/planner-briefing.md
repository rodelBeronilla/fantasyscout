# Planner briefing: where FantasyScout stands and what to do next

Written 2026-11-16 by the agent that has done most of the build, for a planning session that has read the repository at `da8f21d` but cannot see the live data, the open issues or how the work is done. Facts were read on the day from the live site, the GitHub API, the published build's manifest and the decision records. Where something was not checked, it says so.

> **Correction, 2026-11-16.** This briefing first said the owner's team is a punt build (points, threes and assists). It is not: the owner's team punts no category. The belief came from the agent's own notes of 2026-11-03 and spread to issue #925. The lines below are corrected; punt support (#938) is correctness for other leagues, below the owner's own needs.

**The three things to take away:**

1. **The site has shown the same data since 2026-11-11.** The lakehouse's SQL warehouse refuses to start, so every build since has failed. Nothing else in this briefing matters to a manager until that is fixed, and each stale day also loses evidence the January judgements need.
2. **The owner's premise is right, and it is not the main problem.** Large tables are read by no prediction (section 3). But the app is not useful daily for three reasons that come first: the data is stale, the league import is manual, and 25 of 36 features are hidden until at least 2027-01-18.
3. **Every prediction test so far judged a blended score.** The board, its features and every signal that "lost" were scored on the nine-category sum or on fantasy points. In a head-to-head category league each category is won or lost on its own, every week, so a manager weighs categories differently from week to week. No test has asked that question (section 5).

## 1. State of play

### The outage

| | |
| --- | --- |
| Live build | `20261111T095204Z-da8f21d`, NBA data as of 2026-11-10 |
| Age when read | about 5.5 days; the in-season limit is 30 hours |
| Cause | The warehouse answers every start with `HTTP 400 BAD_REQUEST Cannot create the resource, please try again later.` The build fails at "Start the SQL warehouse and wait for it" after twenty minutes of retries. |
| Since | 2026-11-11 17:46 UTC: more than 40 failed builds in a row |
| Incidents | #974 (build failure), #975 (warehouse refuses statements), #977 (publish stale). They opened themselves and nobody acted. |
| Still working | The ingest lands every run (two runs failed on the morning of 2026-11-16; not investigated). The landing zone is complete, so a build can catch up in one run. |
| Not working | Builds, exports, the notebooks, the Tableau sheet and the player notes (they follow a build). |

The runbook's fix is the owner's: open the workspace's SQL Warehouses page, start or recreate the warehouse, and set `DATABRICKS_WAREHOUSE_ID`. **The cause is not known.** One guess, unverified: Free Edition's usage quota. The days before the outage ran a resettle sweep and many builds. If it is a quota, recreating the warehouse will not help and only time or lighter use will.

### In flight

| PR | Branch | What | Waits on |
| --- | --- | --- | --- |
| #967 | `ai/feat/951-notes-history` | Each notes run keeps a dated copy the site does not serve, so the calls can be judged later | the owner's merge |
| #969 | `ai/fix/968-notes-read-site` | The notes' runs after each build got 403 from the site; they now name themselves | the owner's merge |
| #986 | `ai/fix/985-host-task-no-window` | The host's ingest tasks start with no console window | the owner's merge, then a yes to re-register the tasks |
| #923 | `ai/docs/870-reddit-dropped` | The decision record for dropping Reddit | the owner's merge |
| 8 Dependabot PRs | | #730 and #842 are held: they would downgrade the Databricks adapter | a look at each changelog |

Partial work that was never finished sits in worktrees: `ai/fix/939-stale-copy-week-line` (step 1c of the redesign) and four agent worktrees stopped on 2026-11-08 (trade, standings, alerts, sources). Treat the four as cancelled.

### Open milestones

| Milestone | Open | What is left |
| --- | --- | --- |
| 2 Operable and secure | 4 | #424, #425, #426 (narrower credentials, the owner's to set) and #432 (branch protection) |
| 3 Fast and usable | 3 | #563 (Pickups paints after 2.5 s), #557, #447 |
| 5 Smarter for the manager | 4 | #489 (position slots), #491, #495, #517 |
| 1 Correct data, 4 Documented | 0 | Finished, and still open as milestones |

The real plan lives in three epics, not in milestones: **#751** (every number judged out of sample), **#936** (the redesign the owner confirmed on 2026-11-09) and **#734** (match the paid tools).

### The top of the backlog, in the order I would take it

1. The outage (#974, #975, #977), and a second way to build so one warehouse cannot stop the site (section 8).
2. #938 and #925: every page values players under the league's settings and punts; a punted category counts as a loss. #925 and #926 look done by #928 to #934 and are still open; I have not checked them line by line.
3. #939: stale copy, Trade's week line, My Team's games left.
4. #936 steps 2 to 6: Pickups, Trade, Rankings and Player, League and navigation, Behind the data.
5. #956: light builds run unit tests of models they never build.
6. #876 (alerts) and #884 (Yahoo sign-in, blocked on Yahoo approving the app).
7. The reworks the judgements asked for: #886, #887, #888, #895, #896, #867, #868, #902, #903.
8. New data work that waits on a decision to start: #770 (recovery timelines), #772 (contract year), #916 (what the ML benchmark learns).

### What waits on the owner

- The warehouse.
- Merging #967, #969, #986 and #923.
- Yahoo's approval of the app for its Fantasy API (#884).
- The credentials in #424 to #426, and the secrets for web push if alerts are built (#876).
- Whether the brand card becomes the image shown when a link is shared.
- The decisions of 2026-11-08 ("choose for me" on fifteen questions) are recorded as comments on each issue. **I am not sure all of them were carried into the code.** The agents doing it were stopped mid-work. The features are hidden by a switch either way.

### What is out of date in `.sdlc/state.md`

It was last updated on 2026-11-02 and should be rewritten, not patched.

- It says phases 7 and 8 are not started. Both are well under way.
- It lists the NBA backfill as 2023-24 on. The published build holds NBA 2018-19 on.
- It lists five notebooks. Notebook 01 was retired; 06 and 07 were added.
- It asks the owner for a hosted-model API key. The AI notes run on a local model beside the home runner.
- It says the Yahoo import is parked. A bookmark import exists; sign-in is blocked on Yahoo.
- It has nothing on the methodology epic, the walk-forward harness, the features registry, the hidden features, the redesign, accounts, the brand look or the host's scheduled tasks.
- Its tech-debt list says the Schema page's speed is reported, not enforced. It is enforced.
- Its "Velocity: N/A, first sprint" predates about 900 issues and pull requests.

## 2. How the work is done

**Choosing what is next.** In this order: the owner's latest message; then anything red (a failing deploy, a blocked publish); then the next step of the plan the owner last confirmed (#936's ship order); then the smallest fix found on the way, as its own issue and branch. Product judgement goes back to the owner as a short list of choices with a recommendation.

**A weakness to plan around.** The chat acts only when it is spoken to. Nothing watched the incidents between 2026-11-10 and 2026-11-16, so the outage ran five days. The incident issues work; nobody reads them.

**Delegation.** From 2026-11-02 to 2026-11-08 most work ran as parallel subagents, one issue each in its own worktree, with the main chat merging. That produced about 75 merged pull requests in two days at its peak. It also produced features faster than anyone could judge them. On 2026-11-08 the owner stopped the agents. Since then the work is done by hand, one item per branch, and agents start only when the owner asks. Delegation fits independent, well-specified items (a backtest harness, a rework with a declared bar). It fits user-facing design badly: the brief loses what the owner meant.

**Before a merge.**

- Python: `fs-dev check` (ruff, format, mypy, pytest; about 616 tests).
- Lakehouse: the dbt build on the DuckDB sample, the quality checks, and the schema file regenerated.
- Web: lint, type check, about 390 unit tests, about 330 Playwright tests, and an accessibility pass in both themes for a visual change.
- A preview on `preprod`, with the same Lighthouse gate as production (largest paint under 2 s on home and Schema).
- A search of the diff for words the public repository must not carry.
- Evidence in the pull request: the command's output, not a claim.
- For a prediction: the bar is written on the issue before the run, fitted on the tuning seasons, judged once on the judged seasons, and recorded in a decision record whether it passes or fails.

Until 2026-11-10 the agent merged its own pull requests once checks were green, at the owner's direction. The owner's standing rule is now that feature pull requests wait for the owner. Four wait today.

**Cadence.** Bursts. A typical item is two to four hours from issue to pull request, of which checks and the preview take 20 to 30 minutes. A backtest run on a hosted runner takes minutes; a full set (ten league-seasons, four checkpoints) about an hour.

**What slows the work most.**

1. **Unseen seasons.** Almost every question about a prediction ends at "judged on 2026-27's weeks, 2027-01-18". Section 5 says why and what could be done sooner.
2. **No real use to learn from.** The owner does not open the app, so there are no reports of what was wrong on a given day. The 2026-11-08 feedback ("can't trust it, advice is wrong, unclear what to do") is the only round so far, and it was the most useful input the project has had.
3. **The agent cannot see the owner's league.** It cannot sign in to Yahoo. League features are tested on fixtures.
4. **The queue behind the owner.** Merges, credentials and decisions.
5. **The local machine.** No Worker runtime, tooling in a scratch folder that gets cleaned, and long sessions that lose detail when they are summarised.

## 3. Data inventory

Row counts are from the published build of 2026-11-11. Tables that are not exported have no count: the warehouse was down, so they could not be read. "All seasons" means NBA 2018-19 to 2026-27 and WNBA 2018 to 2026: 18 league-seasons, regular season and playoffs, no preseason or play-in.

**Refresh.** The morning ingest (04:30 Eastern, from the host, with GitHub's cron as fallback) lands everything and is followed by a full build. Three report runs (17:15, 18:45 and 21:15 Eastern) land injuries, lineups, lines, the market, news and transactions; each is followed by a light build of what those feed (read from the models' tags, not from a run). The big facts are incremental by game.

**The first pass, checked.**

| Claim | Verdict |
| --- | --- |
| `fct_shot` is read only by pages and notebooks | **Right.** The player page's shot chart, and notebooks 04 and 05. |
| `fct_event` is read only by pages and notebooks | **Wrong in the other direction: no page reads it.** One data-quality notebook does. The largest table (5.7 million actions, each with the ten players on the floor) has no product use at all. |
| `fct_player_tracking` is read only by pages and notebooks | **No page.** Notebook 02 tested two of its 71 columns (touches, potential assists) as a weekly Pickups sort, and they lost. |
| `fct_player_prop` is read only by pages and notebooks | **No page, by rule:** prop lines are private to the owner. Notebook 06 waits for 200 markets before it compares them with outcomes. |
| `fct_game_line` is read only by pages and notebooks | **Notebook 03 only.** Its silver source, `game_lines`, also puts implied points on Pickups and feeds a lopsided-game flag. Neither moves a value. |
| No player-week table exists | **Right.** `fct_team_week_games` counts a team's games per fantasy week. The week-by-week harness (`ops.closeness_backtest`) rebuilds the lakehouse at each week's start and sums the week in Python; nothing is kept. |

**More tables nothing predictive reads** (bold in the last column below): the injury and absence spells and the recovery curves built on them; salaries and walk years; the news claims, feed items and transcripts (by rule, until a source's record is scored); the board's daily ledger; and the misc box-score columns (paint points, fast-break points, fouls drawn, blocks against).

**What predictions do read.** The traditional box score; usage rate (NBA); team pace (WNBA projection, and the matchup score in both leagues); team defence; the official injury listings and what followed them; the standings; the schedule; and ESPN's draft order.

### Gold

| Table | Grain | Coverage | Rows | Refresh | Consumers | Does a prediction read it? |
| --- | --- | --- | --- | --- | --- | --- |
| `dim_date` | date_day | calendar | 4,748 | rebuilt, the morning build | models: `fct_team_week_games` | no |
| `dim_game` | league, game_id | NBA 2018-19 on, WNBA 2018 on | 12,572 | rebuilt, the morning build | pages: /p/; notebooks: 03 | no: reference |
| `dim_player` | league, stats_player_id, valid_from | NBA 2018-19 on, WNBA 2018 on; one row per roster stint | 4,312 | rebuilt, the morning build | models: `fct_availability`, `fct_official_listing`, `fct_player_claim`, `fct_player_game`, `fct_player_rss_item`, `fct_player_salary`, `fct_player_status`, `fct_player_tracking`, `fct_player_youtube_item`, `fct_waiver_trend`, `mart_board`, `mart_minutes_redistribution`, `mart_streamers`; pages: /p/; notebooks: 04, 07 | no: identity |
| `dim_team` | league, season, team_id | NBA 2018-19 on, WNBA 2018 on | 382 | rebuilt, the morning build | pages: /p/, /streamers/; notebooks: 03 | no: reference |
| `fct_absence_spell` | league, player_id, first_game_id | NBA 2018-19 on, WNBA 2018 on (from box scores) | not published | rebuilt, the morning build | none | **no**: built for #770, nothing reads it |
| `fct_availability` | league, report_date, injury_id | observed since late Oct 2026 | 725 | rebuilt, the morning build | models: `fct_injury_status`, `fct_player_status`; notebooks: 03, 04; claims | yes: ESPN status, when the official report has none |
| `fct_board_history` | date, league, player_id | daily since 2026-10-29; stalled 2026-11-11 | 9,354 | merged by every build | notebooks: 06; weekly AI notes | **no**: the ledger no backtest has read yet |
| `fct_event` | league, game_id, action_number | NBA 2018-19 on, WNBA 2018 on | 5,710,891 | incremental by game, the morning build | notebooks: 04 | **no**: no model and no page; one data-quality notebook |
| `fct_game_line` | league, game_id | 7,817 games; which seasons is unverified | 7,817 | rebuilt, the morning build | notebooks: 03 | **no** (its silver source feeds the schedule's implied points) |
| `fct_game_official` | league, game_id, official_key | every played game | 37,774 | rebuilt, every build, light ones included | models: `fct_referee_tendency`, `mart_schedule_upcoming`; notebooks: 03 | no: context shown, tested null |
| `fct_injury_spell` | league, player_id, first_game_id | NBA 2023-24 on, WNBA 2026 | not published | rebuilt, every build, light ones included | models: `fct_recovery_curve` | **no**: feeds the unread recovery curve |
| `fct_injury_status` | league, injury_id, run_no | observed since late Oct 2026 | 725 | rebuilt, the morning build | pages: /p/ | no: player page only |
| `fct_market_value` | league, stats_player_id | current snapshot | 1,758 | rebuilt, every build, light ones included | models: `fct_board_history`, `mart_board`, `mart_minutes_redistribution`, `mart_streamers` | display (vs Mkt, ownership); the prior reads the draft order separately |
| `fct_official_listing` | league, game_id, player_id | NBA 2023-24 on, WNBA 2026 | 86,596 | rebuilt, every build, light ones included | models: `fct_injury_spell`, `fct_status_calibration`; notebooks: 02, 03, 07 | yes: games missed per status, for the totals (unjudged) |
| `fct_player_claim` | league, source, source_id, stats_player_id, kind | since Nov 2026 | 533 | rebuilt, the morning build | player notes | **no**, by rule |
| `fct_player_game` | league, game_id, player_id | NBA 2018-19 on, WNBA 2018 on; regular season and playoffs | 320,382 | rebuilt, the morning build | models: `fct_absence_spell`, `fct_injury_spell`, `fct_official_listing`, `fct_player_salary`, `fct_walk_year`, `int_known_roster`, `int_league_season_state`, `int_market_prior`, `int_player_game_value`, `int_player_projection_parts`, `int_player_window_lines`, `mart_minutes_redistribution`, `mart_player_rolling`, `mart_streamers`; pages: /p/; ops: walk_forward, standings_backtest; notebooks: 02, 03, 04, 05, 06, 07 | yes: every projection and backtest |
| `fct_player_news` | league, article_id, stats_player_id | observed since late Oct 2026 | 510 | rebuilt, every build, light ones included | models: `int_player_news_latest`; pages: /p/; claims | display (flags) |
| `fct_player_prop` | league, game_id, player_id, market, source, bookmaker | observed since late Oct 2026; private | 9,235 | rebuilt, every build, light ones included | notebooks: 06 | **no**: one notebook, waiting for 200 markets |
| `fct_player_rss_item` | league, item_id, stats_player_id | since Nov 2026 | 295 | rebuilt, every build, light ones included | player notes, claims | **no**: notes only |
| `fct_player_salary` | internal | NBA; seasons unverified; private | not published | rebuilt, the morning build | none | **no**: the contract-year study (#772) has not run |
| `fct_player_status` | league, stats_player_id | current snapshot | 150 | rebuilt, every build, light ones included | models: `fct_board_history`, `mart_board`, `mart_streamers`; notebooks: 04 | yes: the next game's status |
| `fct_player_tracking` | league, game_id, player_id | NBA only; row count suggests 2018-19 on, unverified | 220,057 | rebuilt, the morning build | notebooks: 02 | **no**: one notebook test of two columns out of 71 |
| `fct_player_youtube_item` | league, item_id, stats_player_id | since Nov 2026 | 28 | rebuilt, the morning build | claims | **no**: claims only |
| `fct_recovery_curve` | league, level, body_part, games | NBA 2023-24 on, WNBA 2026 | not published | rebuilt, every build, light ones included | models: `mart_recovery_timeline` | **no**: unvalidated, nothing reads it |
| `fct_referee_tendency` | league, season, official_key | per league-season | 1,002 | rebuilt, every build, light ones included | models: `mart_schedule_upcoming` | no: context shown, tested null |
| `fct_shot` | league, game_id, game_event_id | NBA 2018-19 on, WNBA 2018 on | 2,136,534 | incremental by game, the morning build | pages: /p/; notebooks: 04, 05 | **no**: the player page's shot chart and two notebooks |
| `fct_starting_lineup` | league, game_id, player_id | NBA, today | not published | rebuilt, every build, light ones included | models: `mart_board`, `mart_streamers` | display; My Team's start and sit facts |
| `fct_status_calibration` | league, status, reason_group, games_missed | from the official listings | 1,418 | rebuilt, every build, light ones included | models: `mart_board`; notebooks: 03 | yes: games missed per status |
| `fct_team_game` | league, game_id, team_id | NBA 2018-19 on, WNBA 2018 on | 25,144 | rebuilt, the morning build | models: `fct_absence_spell`, `fct_official_listing`, `fct_referee_tendency`, `int_player_projection_parts`, `mart_minutes_redistribution`, `mart_schedule_upcoming`; notebooks: 03, 04; Tableau extract | yes: pace (WNBA projection), defence and pace (matchup) |
| `fct_team_game_context` | league, game_id, team_id | 27,310 team-games | 27,310 | rebuilt, the morning build | models: `mart_schedule_upcoming`; notebooks: 03 | no: rest, travel and altitude shown as context |
| `fct_team_stakes` | league, season, team_id | current season | 45 | rebuilt, the morning build | models: `mart_board`, `mart_streamers`; notebooks: 03 | partly: the assumed rest-risk charge in the totals |
| `fct_team_week_games` | league, season, team_id, fantasy_week | current season | 658 | rebuilt, the morning build | pages: /streamers/, /team/ | facts: games per fantasy week |
| `fct_transaction` | transaction_key | NBA movement feed and ESPN lines | 10,283 | rebuilt, every build, light ones included | pages: /p/, /streamers/ | no: display |
| `fct_waiver_trend` | league, sleeper_player_id | NBA, newest file | 79 | rebuilt, every build, light ones included | models: `mart_streamers`; notebooks: 04 | no: display |
| `fct_walk_year` | league, season, player_id | NBA seasons played | not published | rebuilt, every build, light ones included | none | **no**: hindsight input for #772 |
| `int_known_roster` | internal | point-in-time builds | not published | rebuilt, every build, light ones included | models: `int_player_projection_parts` | yes: who a backtest projects |
| `int_league_season_state` | internal | per league | not published | rebuilt, the morning build | models: `fct_team_stakes`, `feed_freshness`, `int_player_projection_parts`, `mart_streamers` | yes: which season the board values |
| `int_market_prior` | internal | NBA, current season | not published | rebuilt, the morning build | models: `mart_board` | yes: the validated prior |
| `int_player_game_value` | internal | NBA 2018-19 on, WNBA 2018 on | not published | rebuilt, every build, light ones included | models: `mart_player_consistency` | no: consistency only (hidden) |
| `int_player_news_latest` | internal | current snapshot | not published | rebuilt, every build, light ones included | models: `mart_board`, `mart_streamers` | display |
| `int_player_projection_parts` | internal | current rosters | not published | rebuilt, every build, light ones included | models: `mart_player_projection`; ops: walk_forward, projection_features | yes: the projection |
| `int_player_window_lines` | internal | NBA 2018-19 on, WNBA 2018 on; regular season only | not published | rebuilt, the morning build | models: `int_league_season_state`, `int_player_projection_parts`, `int_value_scale`, `mart_category_zscores`, `mart_streamers`; ops: walk_forward, standings_backtest, closeness_backtest | yes: rates and minutes |
| `int_value_scale` | league, season | per league-season | not published | rebuilt, every build, light ones included | models: `int_player_game_value`, `mart_board`, `mart_category_zscores`, `mart_streamers`; ops: walk_forward, projection_features, standings_backtest | yes: the units of every value |
| `mart_board` | league, season, player_id | current rosters, both leagues | 718 | rebuilt, every build, light ones included | models: `fct_board_history`, `mart_streamers`; pages: /, /draft/, /league/, /p/, /streamers/, /team/, /trade/; ops: walk_forward and the backtests on its exports; notebooks: 06; AI notes; Tableau extract | the value itself |
| `mart_category_zscores` | window_name, league, season, player_id | season, last 20, last 10, per league-season | 19,323 | rebuilt, every build, light ones included | models: `mart_board`, `mart_streamers`; pages: /p/; ops: walk_forward; notebooks: 02, 07 | yes: windows, buy low, Pickups trend |
| `mart_minutes_redistribution` | league, team_id, player_id, teammate_id | this season and last | 3,044 | rebuilt, every build, light ones included | pages: /team/ | unjudged call (hidden) |
| `mart_player_consistency` | league, season, player_id | per league-season | not published | rebuilt, every build, light ones included | models: `mart_board` | no: display (hidden) |
| `mart_player_projection` | league, player_id | current rosters | 718 | rebuilt, every build, light ones included | models: `int_value_scale`, `mart_board`; ops: walk_forward, projection_features, projection_challenger | yes |
| `mart_player_rolling` | league, game_id, player_id | NBA 2018-19 on, WNBA 2018 on | 263,358 | rebuilt, the morning build | models: `mart_streamers`; pages: /p/ | yes: last five and ten, the Pickups sort |
| `mart_recovery_timeline` | league, level, body_part | NBA 2023-24 on, WNBA 2026 | not published | rebuilt, every build, light ones included | none | **no**: unvalidated, nothing reads it |
| `mart_schedule_upcoming` | league, game_id | next seven days | 101 | rebuilt, every build, light ones included | models: `mart_streamers`; pages: /p/, /streamers/, /team/; notebooks: 03 | yes: the matchup score (assumed weights) |
| `mart_streamers` | league, player_id | free-agent candidates | 482 | rebuilt, every build, light ones included | models: `fct_board_history`; pages: /streamers/; notebooks: 02, 07 | the Pickups table |

### Silver

Silver is not exported, so it has no row counts here. A silver table has about as many rows as the gold fact it feeds.

| Table | Grain | Coverage | Refresh | Read by | Does a prediction read it? |
| --- | --- | --- | --- | --- | --- |
| `espn_events` | ESPN event | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `game_lines`, `game_xwalk` | no: joins and lines only |
| `espn_fantasy_market` | league, player | current snapshot | rebuilt, every build, light ones included | `fct_market_value` | display (rank, ownership) |
| `espn_player_game` | ESPN player, game | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `player_game_reconciliation`, `player_xwalk`, `player_xwalk_review` | no: reconciliation only |
| `espn_preseason_adp` | league, season, player | NBA past seasons and 2026-27; no WNBA | rebuilt, the morning build | `int_market_prior` | yes: the market prior |
| `espn_roster_players` | league, ESPN athlete | current snapshot | rebuilt, the morning build | `dim_player`, `fct_availability`, `player_xwalk` | no: identity |
| `espn_team_directory` | league, ESPN team | current snapshot | rebuilt, the morning build | `team_xwalk` | no: identity |
| `event_lineups` | league, game, action | NBA 2018-19 on, WNBA 2018 on | incremental by game, the morning build | `fct_event` | **no**: feeds only fct_event |
| `events` | league, game, action | NBA 2018-19 on, WNBA 2018 on | incremental by game, the morning build | `event_lineups`, `fct_event` | **no**: feeds only fct_event |
| `game_lines` | ESPN event | see fct_game_line | rebuilt, the morning build | `fct_game_line`, `mart_schedule_upcoming` | display; the blowout term of the hidden Top adds |
| `game_officials` | league, game, official | NBA 2018-19 on, WNBA 2018 on | rebuilt, every build, light ones included | `fct_game_official` | no: context only |
| `game_xwalk` | stats game to ESPN event | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `fct_game_line`, `game_officials`, `player_game_reconciliation`, `player_props`, `player_xwalk`, `player_xwalk_review` | no: identity |
| `games` | league, game | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `dim_date`, `dim_game`, `dim_player`, `fct_event`, `fct_player_game`, `fct_player_tracking`, `game_xwalk` | yes, through the box scores |
| `injuries` | ESPN listing | observed since late Oct 2026 | rebuilt, the morning build | `fct_availability` | yes: fallback status for availability |
| `injury_status_history` | listing, run of a status | observed since late Oct 2026 | rebuilt, the morning build | `fct_availability`, `fct_injury_status` | yes: fallback status |
| `official_injury_report` | league, game, player, report | NBA 2023-24 on, WNBA 2026 | rebuilt, every build, light ones included | `fct_official_listing`, `fct_player_status` | yes: availability calibration |
| `player_birth_dates` | league, player | reference | rebuilt, the morning build | `int_known_roster` | no: identity (age reaches only the ML benchmark) |
| `player_claims` | claim | since Nov 2026 | rebuilt, the morning build | `fct_player_claim` | **no**, by rule: no number reads a claim |
| `player_day_tracking` | NBA player, game date | NBA only | rebuilt, the morning build | `fct_player_tracking` | **no** |
| `player_game_advanced` | league, game, player | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `fct_player_game` | partly: usage rate and pace; the rest unread |
| `player_game_box` | league, game, player | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `dim_player`, `event_lineups`, `fct_event`, `fct_player_game`, `fct_player_tracking`, `player_game_reconciliation`, `player_xwalk`, `player_xwalk_review`, `reconciliation_summary` | yes: everything starts here |
| `player_game_misc` | league, game, player | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `fct_player_game` | **no**: columns reach fct_player_game, nothing reads them |
| `player_game_reconciliation` | league, game, player | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `fct_player_game`, `reconciliation`, `reconciliation_summary` | no: source agreement |
| `player_game_usage` | league, game, player | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `fct_player_game` | partly: usage weight in the NBA projection |
| `player_news` | article, player | observed since late Oct 2026 | rebuilt, every build, light ones included | `fct_player_news` | display (headline flags) |
| `player_props` | game, player, market, book, snapshot | observed since late Oct 2026 | rebuilt, every build, light ones included | `fct_player_prop` | **no** |
| `player_xwalk` | stats player to ESPN athlete | reference | rebuilt, the morning build | `dim_player`, `fct_availability`, `fct_market_value`, `int_market_prior`, `player_game_reconciliation`, `player_news`, `player_props`, `player_xwalk_review` | no: identity |
| `player_xwalk_review` | unmatched player | reference | rebuilt, the morning build | none | no |
| `players` | league, player | reference | rebuilt, the morning build | `dim_player`, `player_props`, `transactions` | no: identity |
| `rosters` | league, season, team, player | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `dim_player`, `fct_official_listing`, `fct_player_salary`, `int_known_roster`, `player_xwalk` | yes: who is on the board |
| `rss_feed_items` | feed item | since Nov 2026 | rebuilt, every build, light ones included | `fct_player_rss_item` | **no**: notes and claims only |
| `schedule` | league, game | NBA 2018-19 on, WNBA 2018 on, with the games to come | rebuilt, the morning build | `dim_game`, `espn_preseason_adp`, `fct_walk_year`, `game_officials`, `int_known_roster`, `int_league_season_state`, `int_market_prior`, `int_player_projection_parts`, `mart_schedule_upcoming`, `player_props`, `schedule_team_games` | yes: games left, weeks |
| `schedule_team_games` | league, team, game | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `fct_absence_spell`, `fct_injury_spell`, `fct_team_game_context`, `fct_team_stakes`, `fct_team_week_games`, `mart_board` | yes: games left; spells |
| `shots` | league, game, shot | NBA 2018-19 on, WNBA 2018 on | incremental by game, the morning build | `fct_shot` | **no**: feeds only fct_shot |
| `standings` | league, season, team | latest landing per season | rebuilt, the morning build | `fct_team_stakes`, `int_league_season_state` | yes: season state, rest risk |
| `starting_lineups` | NBA game, player | today's file | rebuilt, every build, light ones included | `fct_starting_lineup` | display (starter, bench, inactive) |
| `team_current` | league, team | reference | rebuilt, the morning build | `fct_official_listing`, `fct_player_status`, `fct_team_week_games`, `fct_transaction`, `fct_waiver_trend`, `mart_board`, `player_props` | no: identity |
| `team_game_box` | league, game, team | NBA 2018-19 on, WNBA 2018 on | rebuilt, the morning build | `fct_team_game`, `games` | yes: pace, defence |
| `team_xwalk` | stats team to ESPN team | reference | rebuilt, the morning build | `fct_availability`, `fct_game_line`, `game_xwalk`, `mart_schedule_upcoming`, `player_props`, `player_xwalk`, `player_xwalk_review`, `transactions` | no: identity |
| `teams` | league, season, team | reference | rebuilt, the morning build | `dim_team`, `fct_status_calibration`, `mart_board`, `mart_streamers`, `team_current`, `team_xwalk` | no: identity |
| `transactions` | transaction | NBA movement feed and ESPN lines | rebuilt, every build, light ones included | `fct_transaction`, `fct_walk_year`, `int_known_roster` | partly: point-in-time rosters only |
| `waiver_trending` | NBA player | newest file only | rebuilt, every build, light ones included | `fct_waiver_trend` | display |
| `youtube_transcripts` | video, half minute | since Nov 2026 | rebuilt, the morning build | `fct_player_youtube_item` | **no**: claims only |
| `youtube_videos` | video | since Nov 2026 | rebuilt, the morning build | `fct_player_youtube_item`, `youtube_transcripts` | **no**: claims only |

## 4. Feature verdicts

`methodology/features.yml` holds 36 features: 7 validated, 12 failed, 13 open and 4 that are plain data. Effort: **S** is a day or less, **M** two to four days, **L** one to two weeks. "Wait" means the calendar decides, not the work.

### Failed

| Feature | Why it failed | What would have to change | Effort |
| --- | --- | --- | --- |
| Playoff odds | They beat a coin and the standings order at every checkpoint. They fail only on calibration: the matchups tally is too timid early (slopes 1.29 to 1.41), and WNBA 2025's categories tally too sure. Two reworks were rejected (ADR 0028, 0029). | Judge calibration pooled, once, on the locked seasons (the owner's choice on #907). Or accept the bar as "beats both baselines" and show the odds from about six weeks out. | S to run; it spends the locked seasons |
| Power rankings | In the NBA they weaken through the season and fail at half way. The market's mean draft rank orders teams far better (0.22 to 0.52 against −0.02 to 0.30). The test is strict: teams drafted by the board's own values differ only by the board's errors. | Carry the market prior into the category values the standings read, and lean on the real record as the season goes. The owner chose to remove the NBA order. | M, then wait |
| Too close to call | The fit was degenerate: the replay rewarded a wider band because more categories became targets. At the fitted WNBA value, 94% of categories would read as too close. | A definition, not a fit. "A chance between 45% and 55%" is a label on a validated chance. I would reclassify it as arithmetic on a validated number and show it. | S, the owner's call |
| Roster swaps | Positive in every season, but the interval reaches zero in NBA 2024-25 and WNBA 2025. Judged over the rest of a season, in leagues that do not punt. | Offer a swap only when its gain clears the value's measured error (#895). The bar is declared for 2026-27's weeks. | M, then wait to 2027-01-18 |
| Trade verdict (even, fair, favours) | The fit collapsed: any positive gain was worth taking, so nothing is "even". The predicted gain is too timid in three season-formats (slope 1.24 to 1.43). | Derive the even band from the gain's measured error (#886). Rescale the gain. | M, then the locked seasons or April 2027 |
| Suggested trades | They lose to the page's own no-model package in both WNBA seasons and tie it in NBA 2023-24. | Rank and filter them as the finder does, or remove them. The owner chose removal. | S to remove |
| Trade finder | The manager gains, with intervals clear of zero. The partner loses in NBA 2024-25 and WNBA 2025, so "win-win" is false. | Require the partner's predicted gain to clear the bar, or drop the label. The owner chose the first. | M, then wait |
| Build your team | It is the three above, on My Team. | Returns with them. | none of its own |
| Explain this trade | It explains the verdict that failed. | Returns with the verdict. | none of its own |
| Fit | The standings weights do not beat equal weights: two of four head-to-head seasons, one of four rotisserie. Its gain over the naive manager comes from the board. | Drop the weighting. Value under the league's own categories is arithmetic on validated value. The owner chose this. | S |
| Sell high | Its players do fall back. The naive list (last ten against the season average) finds players who fall back as far. | Rank by the market's overrating, or drop it. The owner chose to drop it. | S to remove; M to rework |
| Trade chips | Dropping a "trade, don't drop" player for the best free agent did as well or better in three of four seasons. | Drop the line. The owner chose this. | S |

### Open

| Feature | Why it is unjudged | What would have to change | Effort |
| --- | --- | --- | --- |
| Preseason value | Before a season its ranking is level with last season's line, and the market's top tier is better. The market prior fixed part of that on two seasons. | Nothing until April 2027. Out of season now; the in-season badge ends about 20 team games in. | Wait |
| Season and rest-of-season totals | The share of games a player will play was chosen in sample and never judged. Two of its inputs are assumed. | Declare a bar on #754 and judge the share on its own. The data is all there: listings since 2023-24, absences from every box score. | M |
| Mid-week matchup chances | The simulated weeks have weekly totals only, so the way the spread falls as games are played is assumed. | Sum the weeks by day; the box scores have dates. This fits no new number, so I believe it can be judged on past seasons now. | M |
| Stream picks | The band that chose their targets failed; the picks were never judged apart from it. | Target by chance-weighted value (#902). Bar declared for 2026-27's weeks. | M, then wait |
| Weekly lineup plan | No harness replays a week with slots: every backtest plays every player. | A slot-aware replay. Past weeks can serve: it needs box scores and the schedule only. | L |
| Top 3 adds | The window value behind it mixes last-ten production, games and a matchup score whose weights are assumed. The same table shows as data. | Replay each week's top three against what they added. The old notebook test did this for the sort, on a blended score. | M |
| Who takes an out player's minutes | An average over missed games, never scored out of sample. An earlier study found the uplift real but could not say who gets it, on fantasy points. | Score it per category and per week. The play-by-play lineups give far more evidence than missed games do. | M to L |
| Games-missed estimate and IL moves | The estimate averages what followed past listings. The recovery curves by body part exist and nothing reads them. | Judge the estimate against games then missed; use the curves if they beat the average. | M |
| AI notes and their calls | The model's calls cannot be remade for a past day, and none were kept. | Merge #967, then wait. **Every day without it, and every day of the outage, is lost evidence.** | S, then wait |
| Your categories against the league | The season aggregate does not yet count punts. | The punt rework (#938), then a bar. | M |
| Buy low, WNBA | A swing of 5.9 flags too few players to judge. | A swing scaled to the shorter season. Out of season until May. | M, low priority |
| Consistency | No bar was declared, because it is not clear what decision it serves. | Say what it is for first. As a labelled column it is data. | S |
| Auction values and the draft room | No past auctions to judge against. | Before the 2027-28 drafts. | Wait |

**A pattern worth the planner's attention.** Seven of the twelve failures are calls about trades and rosters judged on simulated leagues, where teams are drafted near-equal and nobody punts. That test is strict in one way and blind in another: it cannot say whether advice works for a team built around a few categories. The owner's league is exactly that case.

## 5. How predictions are judged

### Seasons

| Role | NBA | WNBA | Status |
| --- | --- | --- | --- |
| History only | 2018-19, 2019-20 | 2018 to 2020 | Feed the first tuning seasons' priors. Not used as targets. The WNBA's 2018 and 2019 lineups are the weakest data in the lakehouse. |
| Tuning | 2020-21 to 2022-23 | 2021 to 2023 | Every fit happens here. About 71 NBA and 51 WNBA fantasy weeks. |
| Judged | 2023-24, 2024-25 | 2024, 2025 | **Spent** for every number fitted so far: the standings spreads, the matchup spreads, the trade and roster thresholds, the buy-low swing, the playoff share, the market prior and the projection's features. |
| Locked | 2025-26 | 2026 | One judgement each, kept for a final hold-out once the reworks are frozen (#907). |
| Live | 2026-27, begun 2026-10-20 | 2027 | Week-level bars are declared for 2027-01-18 and 2027-03-15; season-level for April 2027. |

**How many unseen seasons a new signal has.** Read strictly: one locked season per league, and the season being played. Read as the repository has practised: "spent" is per number. A new signal, fitted on the tuning seasons and judged once on the judged seasons under a bar written first, is how the projection's features entered on 2026-11-08, after other numbers had already used those seasons. That is defensible once per signal. It weakens with every signal that takes the same road, and about ten have.

**The locked seasons are not untouched.** The notebooks' tests of 2026-10-30 (defence by position, the Pickups signals, teammate absence, referees) used NBA 2025-26 and WNBA 2026 as their test seasons, and ADR 0009 chose the projection's weights on replays that included them. They are clean for the walk-forward numbers only.

### Targets, grains and bars in use

| What | Target | Grain | Bar |
| --- | --- | --- | --- |
| Board value (ADR 0031) | Value per game over the rest of the season: the nine categories summed, above replacement | Player × checkpoint (first game day, a tenth, a quarter, half way) | Error below the naive manager's, interval clear of zero. Accepted after the results, which the record says. |
| Market prior (ADR 0020) | The same sum | Player × checkpoint | Rank correlation up at the first two checkpoints, error no worse anywhere |
| Projection features (ADR 0030) | The same sum | Player × checkpoint, pooled | Pooled error down with the interval below zero; no checkpoint worse by 0.010; ranking not worse |
| Head-to-head and matchup chances (ADR 0021, 0026) | A category won or lost in a week | Team pair × category × week, 200 simulated leagues | Beats a coin and the naive manager; calibration slope 0.8 to 1.25 |
| Trades, swaps, drop rule (ADR 0023, 0024) | Categories won a week against every other team, rest of season | Simulated team × decision | The decision beats standing pat and the naive manager in every judged season |
| Buy low, sell high (ADR 0027) | Value per game after the flag, against the last ten | Flagged player | Reverts further than the naive list's players |
| Playoff odds (ADR 0025) | Made the playoffs or not | Simulated team × checkpoint | Beats a coin and the standings order; calibration slope |
| Pickups sort and the signals around it (ADR 0011, 0012) | What a pickup adds to the next seven days, summed over categories | Candidate × Monday | Finds 0.3 more of the week's ten best pickups, t of 2 or more |
| Earlier signal studies (ADR 0012) | Fantasy points per minute or per game (ESPN's default points) | Player × game | Share of the game-to-game swing explained out of sample |

The baseline everywhere is the **naive manager**: the season so far per game, or last season's line before a first game. A second baseline, the market, exists only for NBA preseason.

### Tests that judged a blend where a category or a week might have answered differently

1. **The projection's features.** Usage entered because it lowered the error of the nine-category sum. It moves points, threes and turnovers: the volume categories. Pace failed in the NBA on the same sum. Neither was scored on rebounds, steals, blocks or the two percentages alone. A manager who punts volume categories got a projection tuned on categories they ignore.
2. **Tracking as a Pickups sort.** Touches and potential assists were tried as a weekly trend against the summed week. Nobody asked whether potential assists improve the assists projection, rebound chances the rebounds projection, deflections steals, or contested shots blocks. That is the natural use of all 71 columns.
3. **Defence by position.** It explained nothing of fantasy points per minute. Positional defence is about which categories a defence concedes (threes to guards, rebounds and blocks to centers). A blended points score averages that away.
4. **Teammate absence.** The uplift was real (about 2 fantasy points a game) and the study could not say who receives it, on fantasy points and on the Pickups sum. Minutes moved by 1.4 to 2.0 per ten points of share and usage by 0.7. Which categories move, and for which position, was not asked.
5. **The betting line.** It lost to defence and pace on fantasy points. Its one clear effect was on minutes in lopsided games, which matters per week for a starter with four games, not per game.
6. **Expected games.** Weighting a pickup by the chance he plays only repeated what the health filter does, for free agents. For the manager's own roster it sets the week's games, and so the matchup chances. That was not tested.
7. **The board itself.** Its validation is on the sum, per game, over the rest of a season. The manager's decisions are weekly and per category. The matchup chances are the one feature judged at the right grain, and they passed in every season.
8. **The ML benchmark.** One model per category, judged on the sum. Its per-category errors were never compared with the transparent model's.

**What follows.** A kept **player-week table** (player × fantasy week × category: the projected line, the games scheduled, the status at the week's start, and what happened) would let every question above be asked again at the manager's grain, on the tuning and judged weeks, for no new data. It is the cheapest high-value piece of modelling open.

## 6. Constraints

- **Databricks Free Edition.** One 2X-Small SQL warehouse, which is the only way production builds run. It has refused statements once before (2026-11-01, a few hours) and is refusing now (five days). Catalogs can only be made in the UI. Its outbound internet is fixed, so everything that fetches runs on GitHub or the home runner. A full build is about 15 minutes; `mart_board` (82 s) and `mart_streamers` (49 s) are the slow tail.
- **Backtests do not need it.** The walk-forward harness mirrors the landing zone to a hosted runner (NBA 2025-26 is 1.1 GB; three seasons mirror in 11 minutes) and builds on DuckDB in about 2 minutes. The same road could publish the site (section 8).
- **The home runner.** The stats hosts block GitHub's runners, so every stats fetch runs from one always-on machine at home, which also runs the local language model. If it is off, there are no box scores. Its outbound traffic goes through an allow-list.
- **The stats API's request economy (ADR 0004).** One request at a time per host, 1.5 to 3 seconds apart, cookies dropped before each. An NBA season costs about 1.7 hours to backfill. Box scores and play-by-play are per game; advanced, usage, misc and shots have season-level forms. Tracking and hustle are per day, NBA only. The WNBA host serves no tracking at all.
- **History that cannot be bought back.** ESPN's injury statuses, the fantasy market's ownership, news, props and waiver trends exist only from the day ingestion began (late October 2026). Official injury reports go back to NBA 2023-24 and WNBA 2026. Past WNBA seasons have no draft market. A point-in-time build of a past season has none of these, so a feature that needs them can be judged only from 2026-27 on.
- **Terms.** Raw payloads are never republished. Bulk tables are private to the owner (ADR 0008). Prop lines go to no page. The project does not get around bot protection, and stops and deletes if a source objects. Reddit is closed to new apps.
- **Privacy on a public repository.** Workflow artifacts can be downloaded by anyone, so nothing holding a source's words is ever one. Those jobs run whole on the home runner.
- **Cost.** Everything runs on free tiers plus one home machine: no budget line, and no headroom either. The one paid-shaped limit is The Odds API's request quota for props.
- **The local model.** Small, on one GPU, reachable only by the home runner. Its calls cannot be reproduced for a past day.
- **The speed budget.** Largest paint under 2 s on a slow phone for home and Schema. Schema has about 0.3 s of room; Pickups is over (3.3 s) and only reported.
- **The WNBA is out of season until May 2027.** Nothing about it can be judged live before then.

## 7. The owner's league

- **Platform and format:** Yahoo; head-to-head; nine categories; eight teams (corrected 2026-11-17: twelve was a setup still on the defaults). The team plays all nine categories (no punts).
- **Sign-in import:** built in the Worker and closed. Yahoo answers 403 until it approves the app for its Fantasy API (#884). There is no public league data to read without it.
- **Bookmark import:** this is the working road. The manager runs a bookmark on their own signed-in Yahoo page. It brings the rosters, the standings, this week's opponent and score, and the playoff weeks into the browser, and the setup can be saved to an account.
- **Does it work end to end?** In tests, yes: unit tests and a Playwright test against saved Yahoo pages (one of which failed once and passed on a second run). **Against the owner's live league I cannot say.** The agent cannot sign in, and nothing records when the owner last ran it.
- **Its limit for daily use:** it is a copy from the moment it ran. An add, a drop or a new score in the league is invisible until the manager runs it again. An ESPN league re-reads itself every fifteen minutes; a Yahoo league cannot. This alone is enough to make the app a place the owner visits rarely.

## 8. My view

### Where I think the framing is off

- **"The platform holds more than the advice uses" is true and is the second problem.** The first is that a manager opening the app today sees five-day-old data, a league copied by hand, and tables where the advice used to be. More signals will not change that.
- **The validation rule is now the tightest constraint on the product.** Hiding every call until an unseen season judges it was the right answer to "I can't trust it". Its cost is that the owner's own season is the test set, so the app is at its least useful in the season it is for. The planner should decide, with the owner, which calls may be judged on past weeks now (my list is in section 4) and which truly need 2026-27.
- **"Validated" has meant "over a season, on the sum".** The owner plays all nine categories, so the sum is the right target for his season. His decisions are weekly and per category, and only the matchup chances were judged at that grain.
- **Several unused signals were tested and lost.** Planning should not assume they are free wins. It should assume they were asked the wrong question.

### The five highest-leverage uses of data already held

1. **Box scores, schedule and listings → a player-week table, and every judgement re-asked per category and per week.** No new ingestion. It turns the board's validation into the manager's question, and it is the base for everything below.
2. **Tracking and hustle (220,057 player-games, 71 columns) → category-specific features in the projection.** Rebound chances for rebounds, deflections for steals, contested shots and box outs for blocks and rebounds, potential assists for assists. Each is one coefficient under ADR 0030's rule, judged on its own category. NBA only.
3. **Shots (2.1 million, with coordinates) → field-goal percentage from where a player shoots.** The pool-wide shrink failed in October because "a center's percentage is not a guard's"; the record names a position-aware prior as the version worth trying. Shot zones are the direct form of it. Field-goal percentage is one of nine categories and the hardest to project.
4. **Play-by-play lineups (5.7 million actions) → who gains what when a teammate sits.** Minutes with and without a teammate, by position and by category, from every stint and not only from missed games. It is the evidence the hidden "who takes his minutes" feature lacks. Honest odds: moderate; the earlier study found per-minute production barely moves.
5. **Official listings and what followed (86,596) plus the recovery curves → the chance each listed player plays each game this week.** It sets the week's games for the manager's own roster, and so the matchup chances, the one validated weekly feature. The curves are built and unread.

Close behind: prop lines as the market baseline the methodology's own bar asks for and never had in season; and the board's daily ledger joined to waiver trends, to see role changes days earlier than a last-ten average does.

### The five things most in the way of daily use

1. **The data cannot be relied on.** Five days stale now; a blocked publish the day before that; red deploys that went unnoticed in early November. One warehouse on a free tier is a single point of failure, and nobody is watching.
2. **The league is not live.** A hand-run bookmark is a weekly habit at best. Until Yahoo approves sign-in, the import needs to be one tap and to say plainly how old its copy is.
3. **There is little left that says what to do.** Hiding unjudged calls removed most of My Team. What remains is correct and thin.
4. **(Withdrawn 2026-11-16.)** This said the owner's punt build was not applied everywhere. The owner does not punt. #938 remains correctness for leagues that do.
5. **Nothing brings the manager back, and nothing learns from them.** No alert when a starter is ruled out (#876). No record of what the app said against what the manager did and what then happened. That record would be both the product's feedback loop and its most persuasive evidence.

### What could visibly ship within two weeks

In order, each small enough to finish:

1. **Data back, and a second road for it** (days 1 to 3). The owner restarts the warehouse. Then a fallback: when the warehouse refuses, build on DuckDB on a hosted runner from the mirrored landing zone and publish that. The harness already does every step but the export. Visible as: the site is never five days old again.
2. **Correct copy and week lines** (days 3 to 5, #939). Visible as: every number on the owner's pages agrees with the others. Punts on every page (#938, #925) follow, below the owner's own needs.
3. **The player-week table and a "last week, graded" card** (days 5 to 9). Each Monday, per category: what the matchup chances said, what happened, and the running record for the season. It is data, not a call, so it may show. It makes the validation visible, and it gathers January's evidence in the open.
4. **Category evidence on Rankings and the Player page** (days 8 to 11). Rebound chances, deflections, contested shots, potential assists and shot zones as labelled, sortable columns under the league's categories. Shown as data, they need no check, and they put the unused tables in front of a manager at once.
5. **One written study, judged in the open** (days 9 to 14): which tracking stats improve the projection of rebounds, steals and blocks, each on its own category, fitted on the tuning seasons and judged once. If one passes it enters the projection by ADR 0030's rule; if none does, the record says so. Either way it is the project's first test at the manager's grain.

Also ready but waiting on someone else: alerts (#876, the owner's push keys), Yahoo sign-in (#884, Yahoo), and step 2 of the redesign, Pickups, which fits in the same two weeks if items 4 and 5 are deferred.

**What I would not promise in two weeks:** any hidden call returning on the strength of 2026-27, a working Yahoo sign-in, or a trade tool that passes its bar.
