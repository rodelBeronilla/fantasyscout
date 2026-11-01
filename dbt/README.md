# dbt

The lakehouse's transformations: bronze, silver, gold and ops models with one SQL body each that
runs on Databricks (`dbt-databricks`, the lakehouse) and on DuckDB (`dbt-duckdb`, CI and local).
Adapter-dispatched macros under `macros/` hide the engine differences (JSON paths, timestamps,
string aggregation, the landing volume); a model never branches on the engine itself.

## Layers

| Layer | Materialisation | What it holds |
| --- | --- | --- |
| `bronze` | incremental, append-only on the landing date | Every landed payload parsed to rows, values still text, one row per payload row, hashed once per file (`landing_files()`, ADR 0004). Files from a landing date older than the table's newest are never re-read. |
| `silver` | table (the play-by-play chain incremental by game) | Typed rows, the latest landing per natural key (`latest_landing()`); a feed the ingest re-lands whole every day is read through `latest_snapshot()`. `events`, `shots`, `event_lineups` recompute only the games with a new landing (`macros/incremental.sql`). |
| `gold` | table; `fct_event`, `fct_shot` incremental by game; `fct_board_history` incremental and never rebuilt | Dimensions (`dim_*`), facts (`fct_*`) and the marts the site reads (`mart_board`, `mart_streamers`, `mart_schedule_upcoming`, `mart_player_projection`, `mart_category_zscores`, `mart_player_rolling`). ADR 0003 records every modelling decision and its addenda. |
| `ops` | table | What the platform says about itself: `test_results` and `publish_gate` (written by `ops.results` after every build), `feed_freshness`, `build_log`, `ingest_log`, `fetch_failures`, the reconciliation tables and `category_config`. |

`models/exposures.yml` names the consumers (the site export, the Tableau workbook, each notebook)
so lineage does not stop at gold; `tests/test_exposures.py` fails when they drift from the code.

## Run it

Locally the project runs on DuckDB against a sample of landed payloads built from the test
fixtures (`dbt/sample/landing`, generated, not committed):

```bash
uv run python dbt/sample/build_sample.py           # once per checkout, and after a fixture changes
cd dbt
DBT_PROFILES_DIR=. uv run dbt build --target duckdb --exclude tag:quality
DBT_PROFILES_DIR=. uv run dbt build --target duckdb --exclude tag:quality   # again: the incremental path
DBT_PROFILES_DIR=. uv run dbt test --target duckdb --select tag:quality     # the data checks, by hand
```

CI runs the first three lines (`.github/workflows/ci.yml`); the export tests, the notebooks and the
Tableau extract then read the sample's `fantasyscout.duckdb`. Against the lakehouse, set the
Databricks environment the runbook names ("Build the lakehouse by hand") and build with
`--target databricks`; the Build lakehouse workflow does that after every ingest, with a "full
refresh" input for the incremental models. `FS_LANDING_ROOT` points DuckDB at another landing
directory (real landed data, say) and `DBT_DUCKDB_PATH` at another database file.

## Variables (`dbt_project.yml`)

- `as_of`: the Eastern date a build computes for. Unset, it is today in New York (`eastern_today()`);
  set, every "today" in gold (rest-of-season counts, the ledger's snapshot date, the news window)
  is that date, which is how the unit tests and the backtests replay a day.
- `landing_root`: where DuckDB reads landed files (`FS_LANDING_ROOT`, default the sample).
- `fantasy`, `fantasy_recency`, `fantasy_durability`, `fantasy_team_change`, `fantasy_recent_minutes`,
  `fantasy_return_ramp`, `fantasy_matchup`: the league the board values players for and the
  projection's weights, each chosen by backtest (ADR 0003); the comments beside them say how.

## Tests and checks

- Schema tests (`_<area>.yml`): keys unique and present, relationships to the dimensions, accepted
  values on every categorical column, documented columns (the export's dictionary requires them).
- Unit tests (`_<model>_unit.yml`): the rules worth pinning, with the inputs mocked and the
  expected rows written out; an incremental model's test overrides `is_incremental` and gives
  `this`.
- Singular checks (`tests/`): basketball logic over real data, `assert_*` at error severity and
  `warn_*` at warn, all tagged `quality`. CI's sample build excludes the tag; the lakehouse build
  runs them, writes every result to `ops.test_results` and decides `ops.publish_gate`: an error
  blocks the export, a warning publishes and is reported (the Data Health page, the incident issue).

## Documentation

`dbt docs generate` renders the catalog; `uv run python -m ops.schema` turns the manifest and the
sample's columns into `web/src/generated/schema.json`, the site's data dictionary (model notes from
each model's leading comment, columns with their descriptions and tests, unit tests, lineage), and
`--check --require-docs` fails CI when the file is stale or an exported gold column is undocumented.
Decisions live in `docs/adr/`; how to operate the build in `docs/runbook.md`.
