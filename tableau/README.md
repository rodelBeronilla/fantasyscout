# League Pulse: the Tableau Public workbook

One workbook, three panels, built from a gold extract: team pace and ratings, the distribution
of player value on the board, and the data-health trend. It is embedded on the site's Dashboards
page once published, and refreshes itself daily through a Google Sheet.

## The extract

`extract.py` writes three CSV files from the published build (or `--source local` from the dbt
DuckDB file): `team_pace_ratings.csv`, `player_value.csv`, `data_health.csv`. The build workflow
refreshes them after every export, publishes them under the build at
`https://fantasyscout.beronilla.rodeo/data/builds/<build_id>/tableau/`, and pushes them into the
League Pulse Google Sheet (`sheets.py`), one tab per file, replaced in full each time.

```bash
uv sync --group notebooks
uv run python tableau/extract.py            # from the published build
uv run python tableau/extract.py --source local
GOOGLE_SERVICE_ACCOUNT_JSON='{...}' uv run python tableau/sheets.py --sheet-id <id>
```

## One-time setup (the owner)

Tableau Public has no publishing API and refreshes only Google Sheets sources on its own, so the
bridge is a sheet the build keeps current, and the workbook is published once by hand.

1. **A service account.** In Google Cloud, create a project (any name), enable the *Google Sheets
   API*, create a service account, and download a JSON key for it. Add the whole JSON file's
   content as the GitHub Actions secret `GOOGLE_SERVICE_ACCOUNT_JSON`. The account needs no Drive
   access and no other permission.
2. **The sheet.** In your Google Drive, create a blank Google Sheet named `FantasyScout League
   Pulse`. Share it with the service account's email address (it ends in `iam.gserviceaccount.com`)
   as *Editor*. Copy the sheet id from its URL (the long token between `/d/` and `/edit`) into the
   GitHub Actions variable `TABLEAU_SHEET_ID`.
3. **The first push.** Run the "Build lakehouse" workflow (or wait for the nightly one). The step
   "Push the extract to the League Pulse Google Sheet" fills three tabs: `team_pace_ratings`,
   `player_value`, `data_health`.
4. **The workbook.** In Tableau Public, connect to *Google Sheets*, pick `FantasyScout League
   Pulse`, and use the three tabs as data sources (no joins). Build three sheets and one dashboard
   named **League Pulse**:
   - *Pace and ratings*: a scatter of `offensive_rating` (x) against `defensive_rating` (y, reversed)
     per team, sized by `pace`, filtered to the current season, with a league filter.
   - *Player value*: a histogram of `value_total` per league, with a top-20 bar chart by `player`.
   - *Data health*: `checks_fail` and `checks_warn` over `run_at` as bars, `passed` as colour.
5. **Publish.** Save to Tableau Public with *Keep this data up to date* ticked, so Tableau Public
   re-reads the sheet daily. Copy the viz URL (the one ending in `/League_Pulse`, without query
   parameters) into the GitHub Actions variable `TABLEAU_VIZ_URL` and run the "Deploy web" workflow.
   The Dashboards page embeds the workbook from then on.

From then on nothing is manual: every passing build refreshes the sheet, and Tableau Public picks
the sheet up within a day. The CSV files stay published with each build for anyone who wants them.
