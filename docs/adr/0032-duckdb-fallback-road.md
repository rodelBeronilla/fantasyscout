# 0032. A second road: build on DuckDB when the warehouse refuses

Date: 2026-11-16
Status: Proposed (#989)

## Context

Production builds had one road, the Databricks SQL warehouse (ADR 0013). From 2026-11-11 09:52 UTC the warehouse answered every start with HTTP 400 "Cannot create the resource, please try again later" (#974, #975, #977, #988). Every Build lakehouse run failed at "Start the SQL warehouse and wait for it" while Ingest kept landing, so the site served the 11-11 build for five days. Retrying for longer would not have helped: the refusal outlasted every retry window.

Everything a build needs except the warehouse already ran elsewhere. `ops.landing_sync` reads the landing volume through the Files API, which needs no warehouse. `dbt build --target duckdb` runs in CI and in the Backtest workflow, which mirrored and built three NBA seasons (3.1 GB) on a hosted runner (#769). `fs-export` has a DuckDB source.

Two things a rebuild cannot recreate. `gold.fct_board_history` is `full_refresh=false`: each day's board is merged in and kept. `ops.test_results`, `ops.publish_gate` and `ops.build_log` are written by the pipeline itself, not by dbt. A DuckDB build that started from an empty file would publish a board history of one day, and the next warehouse build would not know the days the fallback published.

## Options considered

**A. Wait longer for the warehouse.** No code. The site stays stale for as long as the warehouse refuses, which was five days.

**B. A second warehouse or a paid tier.** Needs a new workspace, a new secret or money. Out of bounds (#989: free tiers and today's secrets only).

**C. The same project on DuckDB on a hosted runner, publishing through the same gate.** Free on a public repository, uses only the secrets that exist. The cost is about an hour of runner time per fallback build (measured: 32 minutes to a passing gate, before the notebooks), and a second engine whose results must be shown to agree with the first.

## Decision

Option C, in `.github/workflows/build-fallback.yml` and `ops/fallback.py`:

- **When.** Build lakehouse's dbt job exposes whether the warehouse started. When it did not, the `fallback` job calls Build fallback in `publish` mode, inside the same run, so it holds the same `r2-publish` concurrency group and never races another publish.
- **What it builds: every season.** The mirror takes every season folder of every feed and the run logs under `landing/_ops/` (`--season all --ops`), without the `.meta.json` sidecars no model reads. A hosted runner advertises 14 GB of disk, but the Backtest runs measured 85 GB free on `/` (2026-11-08 and 11-09: `/dev/root 145G 61G 85G`). The first full mirror (PR #994's run, 2026-11-17) copied 62,872 payloads, 10.3 GB, in 25 minutes and left 77 GB free, so a full mirror fits and the fallback builds what the warehouse builds. That is what makes "row counts match" a plain comparison rather than a partial one. The step logs `df` before and after the mirror, so a smaller runner shows in the log first.
- **The ledgers.** Before dbt, `ops.fallback seed` loads the four ledgers from the newest published build's Parquet into the DuckDB file, plus the fallback's own `ops.build_log` rows, which it keeps as JSON in the volume (`landing/_ops/build_log/`) because it writes them after the export. dbt then merges the day into the board history as it does on the warehouse. The published fallback build therefore carries every earlier day.
- **Carry-back.** When the warehouse answers again, its build first runs `ops.fallback carry-back`. That step copies the newest fallback build's ledgers to `landing/_recover/fallback/` in the volume and inserts only the rows the lakehouse lacks, naming and casting every column. It is a no-op once they are in, and it runs before dbt merges today's board. A failure does not stop the build, but it is named in the build's incident.
- **The same gate.** The fallback runs `dbt build` with every check, quality included, then `ops.results --engine duckdb`. Only a passing gate publishes, through the same `publish-build` action (`engine: duckdb`): stage, notebooks, extract, promote.
- **Which road.** `health.json` has always carried `engine`. The Data Health page now names it ("Built by: DuckDB fallback (the warehouse was unavailable)"), and every `ops.build_log` row records its `engine`.
- **Proof that the roads agree.** A daily drill (13:23 UTC, after the morning build) runs the same road in `compare` mode. It builds and exports to the runner without publishing, then compares with the warehouse's build of that morning. Every table's row count must match, and every numeric column of `mart_board` must agree to 1e-9, the walk-forward check's tolerance. The three ledgers each road adds its own run to are listed, not judged. A disagreement is reported in the run's summary and as a warning, and opens no incident: a `data-incident` issue reaches the owner's phone each morning, and a known difference between engines is not an incident (the owner, 2026-11-16; #995 holds the differences). It runs only when the newest build is the warehouse's and under eight hours old, so it compares engines, not two days of landing.
- **Privacy.** The mirror and the exported files hold source text (headlines), so neither becomes a workflow artifact. The mirror is deleted after dbt, and a non-publishing run exports to a runner folder that is never uploaded.

## Consequences

- With the warehouse refusing, every ingest still ends in a published build, so the site stays inside the 30-hour SLA as long as the hosted runner, the Files API and R2 answer.
- A fallback build takes about an hour: on PR #994's run the mirror took 25 minutes, the seed 5 seconds, dbt 6 minutes, the gate and export 1 minute, and the notebooks and extract follow as on the warehouse road.
- Two engines must stay in agreement. The drill measures that daily instead of on the day it matters. Engine differences that already exist show up in the drill's table and become issues there. The first comparison (PR #994, against the warehouse build of the same landing) found two: 12 of 5.7 million `fct_event` rows and 2 `fct_market_value` rows, and board values apart by up to 7.6e-6, which looks like the warehouse rounding a decimal to six places (#995).
- The Asset Bundle stays the fallback for an Actions outage (ADR 0013). This road is the fallback for a warehouse outage. The two are independent.
- Payloads the volume no longer holds but the warehouse's append-only bronze still does would make the roads differ. The drill would show it as a row count difference.
