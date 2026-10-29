# ADR 0006: How gold reaches the site

Status: accepted, 2026-10-27

## Context

The warehouse is never exposed to the internet (SPEC.md). The site serves exported gold data from an R2 bucket through the Worker, a build at a time, with a pointer the export flips only when a build is complete, seven builds kept, and a rollback that is one pointer rewrite. The export runs after every passing gate, so a blocked gate leaves the previous build serving.

## Decision

**Layout.** Everything a build publishes lives under `builds/<build_id>/`: one Parquet per gold model (zstd), JSON beside the small ones, the four big facts split per league-season (`fct_event/wnba-2026.parquet`), `board/<league>.json` and `streamers/<league>.json` with names attached, `health.json` for Data Health, `players/<league>/<player_id>.json` for the player pages, `manifest.json` (build id, engine, git SHA, data-as-of per league, the gate verdict, check counts, row counts, and per file bytes, SHA-256 and rows) and `keys.txt`, the list of every key the build wrote. Two pointers sit at the root: `latest.json` (the current build) and `builds.json` (the builds kept, newest first). Build ids sort chronologically (`20261027T173000Z-f005d66`).

**Order of publication.** Files, then the manifest and the key list, then `builds.json`, then `latest.json`. A reader that follows `latest.json` never reaches a half-published build. Pruning runs last and deletes the keys listed in each dropped build's `keys.txt`, never the build `latest.json` points at, so a rollback target cannot be pruned from under it.

**Transport.** Databricks hands the tables out as Arrow IPC streams on pre-signed links through the SQL Statement Execution API, which moves millions of rows without a driver; the same code reads the DuckDB file locally and in CI. Objects go to R2 through the Cloudflare API's per-object endpoint, the one `wrangler r2 object` uses, with the account id and API token the deploy already holds: no S3 keys to create or rotate. Writes run on a small thread pool and retry on rate limiting.

**Rebuild every night, upload everything.** A build is a few thousand small files and a few hundred megabytes; uploading all of it takes minutes and stays far inside R2's free operations and storage (seven builds). Content-addressed reuse was considered and rejected: it would save bandwidth but would need either a server-side copy the API does not offer or an indirection the pages would pay for on every request, and the build-scoped layout is what the spec describes.

**Per-player files** carry the biography and stints, a line per season, the full game log, the current season's rolling averages, z-scores, the board row, and the current season's shots with the league's zone averages, shaped by one set of SQL in an in-memory DuckDB from the tables already pulled. A player page loads one file of roughly ten kilobytes.

## Consequences

- The site can be rolled back in under a minute without a deploy; the Worker caches the two pointers for 60 s and everything under `builds/` for a year.
- The SQL console's engine (DuckDB-WASM, too large for a static asset) is served from the bucket under `vendor/`, same origin; its Parquet reader is a DuckDB extension fetched at run time from the DuckDB extension repository, the one external origin the Content-Security-Policy's `connect-src` allows. Astro's inlined island loader is allowed by hash, collected from the build before every deploy, so `'unsafe-inline'` stays out.
- A missing ops table on a fresh engine is skipped, not fatal, so a local export works before the first gate has run.
- The export does not diff builds; a nightly export always costs one full pull and upload. If that ever matters, the manifest's per-file SHA-256 is the hook for skipping unchanged uploads.
- The ops tables go out with the build, so Data Health shows the state the build was published with, not a live view; the live view is the Query the lakehouse workflow.
- Charts are drawn as plain SVG by the pages themselves (the shot chart, the rolling trend). A charting library that styles its output inline conflicts with the site's policy, which allows no inline styles; drawing the two charts directly keeps the policy strict and the bundle small.
- Every data island renders in the browser only: they read the league from the address and remembered settings, which the server cannot know, so server-rendered markup could never match.
