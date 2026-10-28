# Notebooks

Three analyses over the gold tables, executed against the newest published build after every
export and rendered at `/notebooks/` on the site; CI executes them against the fixture sample on
every pull request, so a notebook that stops running fails the build.

| Notebook | Question |
| --- | --- |
| `01_shot_profiles` | Where do players shoot from, and how well, compared with the league in the same zone? |
| `02_reconciliation_audit` | How much does the second source cover, how often do the sources agree, and which values differ? |
| `03_fantasy_value_backtest` | Did last season's z-score rank predict this season's value? |

`fs.py` gives every notebook one connection, whichever copy of gold is at hand (`FS_NOTEBOOK_SOURCE`):
`published` reads the site's current build over HTTP with DuckDB's Parquet reader (the default
when no local file exists; `FS_BUILD_ID` pins a build), `local` reads `dbt/fantasyscout.duckdb`,
and `databricks` reads the lakehouse through the Databricks SQL connector into DuckDB.

The notebook sources live in `make_notebooks.py` as plain Python strings, so they are reviewable in
a diff; `uv run python notebooks/make_notebooks.py` regenerates the `.ipynb` files, which are
committed. To run them by hand:

```bash
uv sync --group notebooks
cd notebooks && uv run jupyter nbconvert --to html --execute --output-dir _build *.ipynb
```
