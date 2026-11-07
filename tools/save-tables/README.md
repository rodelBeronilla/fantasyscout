# Save tables

A bookmarklet for pages you read yourself: one click saves every table on the page open in your browser as a JSON file. It sends no request of its own and answers no challenge for you. It only copies what your own tab already shows. This is how pages from sites that refuse automated clients (Spotrac, Pro Sports Transactions) come into the lakehouse, and only those you visit (ADR 0008's addendum of 2026-11-07, #792).

## Install

```bash
node tools/save-tables/make-bookmarklet.mjs
```

Copy the `javascript:` line it prints. Create a bookmark with any name, such as "Save tables", and paste the line as its address.

## Use

1. Open a page with the tables you want, for example a player's contract page or a search result.
2. Click the bookmark. A file named after the page downloads, holding:
   - the page's address, title and the time you saved it;
   - each table's heading, header row and rows;
   - each cell's link.
3. Land the files you saved:

   ```bash
   uv run fs-ingest import ~/Downloads/www.spotrac.com-*.json --source spotrac --league nba --season 2025-26 --backend volume
   ```

   `--source` names where the pages came from, in lower case letters. Files land under `landing/manual/<source>/<league>/<season>/`, and `bronze.manual_tables` reads them as one row per saved table row. A file saved twice lands once.
