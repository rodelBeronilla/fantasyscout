# League Pulse: the Tableau Public workbook

One workbook, three panels, built from a gold extract: team pace and ratings, the distribution
of player value on the board, and the data-health trend. It is embedded on the site's Dashboards
page once published.

## The extract

`extract.py` writes three CSV files from the published build (or `--source local` from the dbt
DuckDB file): `team_pace_ratings.csv`, `player_value.csv`, `data_health.csv`. The build workflow
refreshes them after every export and publishes them under the build at
`https://fantasyscout.beronilla.rodeo/data/builds/<build_id>/tableau/`; the Dashboards page links
to the current ones.

```bash
uv sync --group notebooks
uv run python tableau/extract.py            # from the published build
uv run python tableau/extract.py --source local
```

## Publishing (the one manual step)

Tableau Public has no API for publishing or refreshing, so this is done by hand, once to create
the workbook and again whenever the panels should pick up newer data.

1. Download the three CSV files from the current build (links on the Dashboards page) into one folder.
2. In Tableau Public (desktop app), connect to `team_pace_ratings.csv`; add `player_value.csv` and
   `data_health.csv` as further data sources (no joins needed).
3. Build three sheets and one dashboard named **League Pulse**:
   - *Pace and ratings*: a scatter of `offensive_rating` (x) against `defensive_rating` (y, reversed)
     per team, sized by `pace`, filtered to the current season with a league filter.
   - *Player value*: a histogram of `value_total` per league, with a top-20 bar chart by `player`.
   - *Data health*: `checks_fail` and `checks_warn` over `run_at` as bars, `passed` as colour.
4. Save to Tableau Public. Copy the viz URL (the one ending in `/League_Pulse`, without query parameters).
5. In the GitHub repository, set the Actions variable `TABLEAU_VIZ_URL` to that URL and run the
   "Deploy web" workflow (or push to `main`). The Dashboards page embeds the workbook from then on.

To refresh after new data: download the current CSVs again, open the workbook, use *Data → Edit
Data Source* to point each source at the new file, and save to Tableau Public again. The embed URL
does not change.
