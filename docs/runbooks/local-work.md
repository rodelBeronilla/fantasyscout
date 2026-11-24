# Working on the home machine

The home machine runs the home runners, the local model, the four ingest tasks, and other services of the owner's that must not stall. Agent work on it shares the CPU, the C: drive and one GitHub account. These limits are the owner's rules; each says where it came from.

## CPU: eight worker processes in total

All agent work on the machine shares at most **8 worker processes at a time**, counted across every agent, each at **idle priority** with **no visible window** (owner, 2026-11-16; set after 40 parallel Python processes held the CPU at 100%, and broken once on 2026-11-22 when three review agents ran full Playwright suites at once and his audio cut out). (source: cpu-budget-on-this-pc.md:11-20, 2026-11-22)

- Each agent builds and tests with **2 workers at most**: `--workers=2` for Playwright, `--maxWorkers=2` for Vitest, `--threads 2` for dbt, no `-n` above 2 for pytest. One such run at a time per agent. With four agents running, that is the whole budget.
- Run them at idle priority with no window: `python .tools/idle.py <command> [args...]` (the command and its children run at Idle; output and exit code pass through; use `npm.cmd`, not `npm`). `.tools/` is git-ignored: in a fresh clone, recreate `idle.py` as a `subprocess.Popen` with `creationflags=0x08000040` (idle priority, no window) that passes stdout, stderr and the exit code through. Do not use `start /low` from Git Bash: it rewrites the switches and can open a window.
- A review runs only the specs its diff needs, unless the whole suite is the evidence.
- Heavy computation goes to GitHub's runners (the Backtest workflow), not this machine.
- One Python lane at a time when lanes share one `.venv`; one Backtest run at a time.
- Every sub-agent brief that builds or tests repeats these limits (and `uv run --no-sync` for Python, so it does not rewrite the shared environment).

## Disk: C: is shared

C: is shared with the home server's container engine; below about 10 GB free it stalls and the owner's services drop (2026-11-18). On 2026-11-21 worktrees grew 4.2 GB in 3 hours, each with its own ~1.2 GB `web/node_modules`. (source: worktree-disk-budget.md:11-19, 2026-11-21)

- Before starting a sub-agent or a worktree, read the free space: `(Get-PSDrive C).Free/1GB`. Under 25 GB, clean up first; under 15 GB, start nothing.
- Never `npm ci` or copy `node_modules` into a new worktree. Link one install instead: `cmd //c mklink /J <worktree>\web\node_modules <main checkout>\web\node_modules` (and the same for `worker/`), after one `npm ci` in the main checkout. Unlink the junction before removing the worktree.
- When a worktree's branch is pushed and its agent has finished, remove it (`git status --porcelain` and `git log @{u}..HEAD` empty first). Never remove one you did not make (AGENTS.md).

## GitHub API: one 5,000-an-hour budget

Every `gh` call from every agent on the machine counts against the owner's account. It ran out on 2026-11-21 at 20:36 UTC, and merges, checks and run downloads all failed with 403 until the reset. (source: github-api-budget.md:11-19, 2026-11-21)

- `gh run watch --interval 300`, never the default 3 s. Wait loops on pull requests or runs sleep 60 s or more between calls.
- `gh api rate_limit` costs nothing and shows the reset. On a rate-limit 403, wait for the reset; do not retry.
- The Databricks Files API also throttles (HTTP 429) when several Backtest runs mirror the landing volume at once: one mirroring run at a time.

## Databricks Free Edition

- Outbound internet from the workspace is limited to a fixed set of domains, so nothing may depend on Databricks reaching the internet: ingest pushes files in through the Files API from GitHub Actions, and dbt runs from Actions against the warehouse. (source: databricks-and-tableau-accounts.md:8-12, 2026-10-26)
- The warehouse refuses sessions after about six builds a day ("Cannot create the resource"). Verify a lakehouse change on real data with the Backtest workflow instead: `gh workflow run backtest.yml -f league=nba -f seasons="..."`. Its data rows are separate log lines: a filter on header words once made a good run look empty. (source: methodology-epic-751.md:22-23, 2026-11-08)

## Local pitfalls

Each of these cost work once.

- **Never run Prettier in `web/`.** The repository has no Prettier config; it rewrote all of `web/tests/pages.spec.ts` to double quotes (2026-11-07). (source: fantasyscout-local-tooling.md:22; fantasyscout-2026-11-03-trade-work.md:54)
- **`git checkout <file>` or `git checkout -- .` throws away uncommitted work.** Commit before experiments; to plant a failing literal, copy the file aside and copy it back. (source: ui-rework-2026-11-03.md:34; fantasyscout-2026-11-02-work.md:25)
- **Never edit a bash script while a run is executing it.** Bash reads it as it goes and the run dies mid-way; copy it to a new name instead. (source: fantasyscout-phase-status.md:97, 2026-11-02)
- **A new checkout has no landing sample.** Run `uv run python dbt/sample/build_sample.py` first: a dbt build without it passes on empty tables. A fresh worktree also needs `uv sync --all-extras --all-groups` once, and on Windows `uv run --with tzdata fs-dev check`. (source: fantasyscout-local-tooling.md:18-19)
- **`web/src/generated/schema.json` follows the dbt models and the pages' data fetches.** After a rebase that adds a dbt model: `dbt run` (not `build`) and `dbt docs generate --target duckdb` with `DBT_PROFILES_DIR=.` in `dbt/`, then `uv run python -m ops.schema`; regenerate after rebasing on the final `main`, since two such pull requests in flight conflict. (source: fantasyscout-local-tooling.md:23; ui-rework-2026-11-03.md:32)
- **Playwright previews the last build:** `npm run build` first. `npx playwright test -g` patterns must not contain `|` in Git Bash. (source: ui-rework-2026-11-03.md:33; fantasyscout-local-tooling.md:18)
- **The board's static intro must stay the largest paint on a phone** (a phone test guards it, #717), and the Inter font stays off the first-paint path: never preload it or make it render-blocking (Lighthouse's 2 s gate on home and Schema). (source: ui-rework-2026-11-03.md:31; brand-look-963.md:17-20)
- **Renaming a column on an incremental (`append_new_columns`) model nulls its history.** Rename in silver or gold instead. (source: fantasyscout-2026-11-02-work.md:25)
- **A new board column goes through four layers** (dbt, `export/layout.py`, `export/ts_columns.py`, then the fixture; add new keys to the fixture as nulls). **A new per-league JSON file goes in three places**: the Worker's `CURRENT_PATH`, `copy-fixtures.mjs`, and the page's preload list. (source: competitor-parity-epic.md:28-29, 2026-11-07)
- **Worker tests do not run on this Windows machine** (workerd lacks the Visual C++ runtime): run them in the container described in `docs/runbook.md`, or let CI run them. (source: windows-workerd-needs-vc-redist.md:12)
- **After an egress allow-list change merges**, the proxy reads it only on restart: `docker compose -f infra/runner/compose.yml up -d --force-recreate egress-proxy`. That is a change on the home machine, so it is the owner's (AGENTS.md). (source: fantasyscout-2026-11-08-work.md:15; infra/runner/README.md:39)
