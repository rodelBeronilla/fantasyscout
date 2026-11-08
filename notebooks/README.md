# Notebooks

Six analyses over the gold tables, executed against the newest published build after every
export and rendered at `/notebooks/` on the site; CI executes them against the fixture sample on
every pull request, so a notebook that stops running fails the build.

Each notebook asks a question a fantasy manager acts on, covers both leagues and ends by saving
its headline findings (`_build/<name>.findings.json`: a headline, a few key figures, a short table
and how much evidence they rest on, per league). The build publishes them with the rendered pages,
and `/notebooks/` shows them for the league chosen in the header, linking to the full notebook. A
league the build cannot answer for yet (the fixture sample holds one game) is saved as
`insufficient_history`, and the page says the findings are accumulating instead of showing zeros.
Only aggregates are published: no box-score rows, and player names only in short tables of derived
measures.

| Notebook | Question |
| --- | --- |
| `02_streamer_signals` | Every Monday, which Streamers signal, sorted on, finds the free agents who produce most over the next seven days, and do expected games (from the official injury listings) or an opportunity trend beat the default? |
| `03_game_context` | Do back-to-backs, travel, time zones, altitude, the opponent, the referees and the betting line change whether a regular plays and what they produce per minute, would a matchup read off the line beat defence and pace, and how often does one missed game become several? |
| `04_data_quality` | Per league and season: do the sources agree, do box scores add up, do shot charts match them, are lineups complete, do injury, waiver and status rows link, and are the sources fresh? |
| `05_shooting` | How many attempts before a free-throw, three-point or field-goal percentage (or shooting over expectation) is more skill than luck, and does a first-half edge last? |
| `06_prop_lines` | How far do the board's projections sit from the sportsbooks' player lines, and once the games are played, which was closer? Prop lines are private (ADR 0008): aggregates only. |
| `07_teammate_absence` | When a teammate who plays big minutes or uses many possessions is known to be out, how much do the others' minutes, usage and fantasy production rise, and does adjusting for it beat the last ten games at predicting the affected players' next week? |

`boxscore.py` holds what the notebooks share: reading and normalising `fct_player_game`, per-game
lines, and the build's own value scale (ADR 0019), which `value_scale` reads off the scored season
lines in `mart_category_zscores` rather than re-implementing it. `tests/test_boxscore.py` pins it,
on the dbt sample too.

The board backtest (`01_board_backtest`) is retired, with the pandas replay of the board it ran
on (`replay.py`, #776). That replay re-implemented the projection and an older value scale; the
board is now judged by the walk-forward harness (`ops/walk_forward.py`) on the lakehouse rebuilt
as it stood on each checkpoint (ADR 0018), and the Methodology page gives each number's evidence.

`fs.py` gives every notebook one connection, whichever copy of gold is at hand (`FS_NOTEBOOK_SOURCE`):
`published` reads the site's current build over HTTP with DuckDB's Parquet reader (the default
when no local file exists; `FS_BUILD_ID` pins a build), `local` reads `dbt/fantasyscout.duckdb`
(or the DuckDB file `FS_LOCAL_DB` names, for a local copy of real history), and `databricks` reads
the lakehouse through the Databricks SQL connector into DuckDB.

The notebook sources live in `make_notebooks.py` and the `nb_*.py` modules beside it as plain
Python strings, so they are reviewable in a diff; `uv run python notebooks/make_notebooks.py`
regenerates the `.ipynb` files, which are committed. To run them by hand:

```bash
uv sync --group notebooks
cd notebooks && uv run jupyter nbconvert --to html --execute --output-dir _build *.ipynb
```
