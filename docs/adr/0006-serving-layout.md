# 0006. How gold reaches the site

Date: 2026-10-27
Status: Accepted

## Context

The warehouse is never exposed to the internet (SPEC.md). The site serves exported gold data from an R2 bucket through the Worker, a build at a time, with a pointer the export flips only when a build is complete, seven builds kept, and a rollback that is one pointer rewrite. The export runs after every passing gate, so a blocked gate leaves the previous build serving.

## Decision

**Layout.** Everything a build publishes lives under `builds/<build_id>/`: one Parquet per gold model (zstd), JSON beside the small ones, the four big facts split per league-season (`fct_event/wnba-2026.parquet`), `board/<league>.json` and `streamers/<league>.json` with names attached, `health.json` for Data Health, `players/<league>/<player_id>.json` for the player pages, `manifest.json` (build id, engine, git SHA, data-as-of per league, the gate verdict, check counts, row counts, and per file bytes, SHA-256 and rows) and `keys.txt`, the list of every key the build wrote. Two pointers sit at the root: `latest.json` (the current build) and `builds.json` (the builds kept, newest first). Build ids sort chronologically (`20261027T173000Z-f005d66`).

**Order of publication.** Files, then the manifest and the key list, then `builds.json`, then `latest.json`. A reader that follows `latest.json` never reaches a half-published build. Pruning runs last and deletes the keys listed in each dropped build's `keys.txt`, never the build `latest.json` points at, so a rollback target cannot be pruned from under it.

**Transport.** Databricks hands the tables out as Arrow IPC streams on pre-signed links through the SQL Statement Execution API, which moves millions of rows without a driver; the same code reads the DuckDB file locally and in CI. Objects go to R2 through the Cloudflare API's per-object endpoint, the one `wrangler r2 object` uses, with the account id and API token the deploy already holds: no S3 keys to create or rotate. Writes run on a small thread pool and retry on rate limiting.

**Rebuild every night, upload everything.** A build is a few thousand small files and a few hundred megabytes; uploading all of it takes minutes and stays far inside R2's free operations and storage (seven builds). Content-addressed reuse was considered and rejected: it would save bandwidth but would need either a server-side copy the API does not offer or an indirection the pages would pay for on every request, and the build-scoped layout is what the spec describes.

**Per-player files** carry the biography and stints, a line per season, the full game log, the current season's rolling averages, z-scores, the board row, and the current season's shots with the league's zone averages, shaped by one set of SQL in an in-memory DuckDB from the tables already pulled. A player page loads one file of roughly ten kilobytes.

## Consequences

- The site can be rolled back in under a minute without a deploy; the Worker serves the two pointers with a 60 s cache and everything under `builds/` as immutable for a year, and keeps the public files in Cloudflare's edge cache for those lifetimes (2026-11-01: `caches.default`, bypassed by private tables, range and conditional requests).
- The SQL console's engine (DuckDB-WASM, too large for a static asset) is served from the bucket under `vendor/`, same origin; its Parquet reader is a DuckDB extension fetched at run time from the DuckDB extension repository, the one external origin the Content-Security-Policy's `connect-src` allows. Astro's inlined island loader is allowed by hash, collected from the build before every deploy, so `'unsafe-inline'` stays out.
- A missing ops table on a fresh engine is skipped, not fatal, so a local export works before the first gate has run.
- The export does not diff builds; a nightly export always costs one full pull and upload. If that ever matters, the manifest's per-file SHA-256 is the hook for skipping unchanged uploads.
- The ops tables go out with the build, so Data Health shows the state the build was published with, not a live view; the live view is the Query the lakehouse workflow.
- Charts are drawn as plain SVG by the pages themselves (the shot chart, the rolling trend). A charting library that styles its output inline conflicts with the site's policy, which allows no inline styles; drawing the two charts directly keeps the policy strict and the bundle small.
- Every data island renders in the browser only: they read the league from the address and remembered settings, which the server cannot know, so server-rendered markup could never match.

## Addendum (2026-10-29): staged builds, gated hand exports, pinned rollbacks

Checking the documentation against the code (issue #96) found five gaps. Each is now closed.

- **Builds are staged, then promoted.** The nightly build uploads a build with nothing pointing at it. The notebooks and the Tableau extract read it by id and add their files, then `fs-export promote` writes `builds.json` and `latest.json`. The live build is always complete. A failed notebook or extract does not hold back the day's data: the build goes live without it, and the incident says so.
- **A hand export checks the gate.** The Export workflow runs `ops.gate`, which reads the latest row of `ops.publish_gate` and refuses unless it passed. An `ignore_gate` input exists for emergencies and is logged.
- **A rollback pins.** `latest.json` and the build's `builds.json` entry carry the pin. Promotion still records new builds while the pin holds, but leaves `latest.json` alone. Pruning keeps the pinned build. `fs-export unpin` releases it.
- **The build runs after any finished ingest.** A failed ingest job keeps its own incident. The completeness check counts a game missing only once it has been final for more than a day, so one failed request no longer costs the day's build.
- **The build incident covers every step.** That includes the export, promotion, notebooks, extract and sheet push, and the incident names the steps that failed.

## Addendum (2026-11-01): one publisher at a time

Build lakehouse and Export data each had their own concurrency group, so a scheduled build and an export run by hand could promote at the same moment: `promote` reads `builds.json`, inserts the build and writes it back, and `prune` deletes by a build's key list, so two at once could drop a build from the list or prune a build the other had just pointed `latest.json` at. Both workflows now share the `r2-publish` group (never cancelling the one in progress), and `prune` keeps a build that `builds.json` marks pinned whether or not `latest.json` points at it, so the two records a rollback writes protect the build on their own.

## Addendum (2026-11-02): the current build's page files at a stable address

A page read the pointer, then its file: on a slow phone the board's 172 KB file only started after the scripts had run, about 1.9 s in, and the first rows came at 3.8 s (#436). The Worker now also answers `/data/current/{board,streamers,schedule}/{wnba,nba}.json` by resolving `latest.json` itself and serving that build's file for a minute (`x-build-id` names the build). The Board and Streamers pages preload theirs from the head, for the league the page will pick, so the file downloads beside the pointer. Only those page files are reachable this way, never a private table. Where no Worker answers (the dev server, the test preview), the client falls back to the pointer and the build's own file. The build files themselves stay immutable for a year; the stable address costs one more cached object per file and a minute of staleness, the same as the pointer.

## Addendum (2026-11-02): what is not immutable

The decision said two pointers are served for a minute and everything under `builds/` is immutable for a year. Three kinds of key have changed since, and the Worker names them in `POINTER_KEYS` and `MUTABLE_UNDER_BUILDS` (`worker/src/index.ts`). Each is served `public, max-age=60`:

- **The pointers**: `latest.json`, `builds.json`, and `notebooks/findings-history.json`, which every full build rewrites.
- **A build's lists of itself**: `builds/<id>/keys.txt` and every `index.json` under a build. The export adds the rendered notebooks and the Tableau extract to a staged build after the fact and rewrites these, so a visitor who opened Notebooks while the index listed four notebooks is not held to that list for a year.
- **The stable addresses** of the addendum above (`/data/current/...`): the file of whichever build the pointer names, for a minute.

Everything else under `builds/` is still written once and served `immutable` for a year. Two Worker caches added on the same day keep to the same minute: the current build's id, which the player pages and the players sitemap read, and each named player page are kept at the edge for 60 s (#443). The content-hashed page bundles under `/_astro/` are served by the asset layer as `immutable` for a year (#442).


## Addendum (2026-11-02): failures, the edge cache, player pages and crawlers

Rules the Worker (`worker/src/index.ts`) follows that were decided in pull requests and recorded nowhere else. The three kinds of mutable key in the addendum above came from three changes: the findings history joined the pointers in #352, a build's lists of itself in #332, and the stable addresses in #539.

- **A failure is retried, not remembered.** On `/data/`, R2 refusing a range that starts past the end of an object is the one failure the request caused, and it answers 416. Any other R2 failure answers 503 with `retry-after: 30` and `cache-control: no-store`, so the browser and any cache try again (#333). A missing key is a plain 404.
- **What the edge cache keeps.** A public data file answered 200 is kept in `caches.default` for as long as its `cache-control` says (#334). Private tables, `HEAD` requests, range requests and conditional requests (`If-None-Match`, `If-Modified-Since`) go to R2 every time, and a 404, 416 or 503 is never stored. A hit is answered with the Worker's own `cache-control` rule, never the header stored with it: the zone's browser cache TTL had rewritten a stored pointer's minute to four hours (#498). The cache key is the origin and the path without the query string, so `?v=1` is the same file, not another R2 read (#587). The `/data/current/` addresses follow the same rules.
- **Player pages.** One static shell serves every `/p/{league}/{id}/`. The Worker rewrites its title, description, Open Graph tags and canonical link with the player's name, team abbreviation and position from the current build's player file, so a search result or a link preview names the player before any script runs (#355, #361). An id with no file in the current build answers 404 with the same shell (#584). A named page is kept at the edge for a minute and carries no `ETag` or `Last-Modified`, so a browser cannot keep an old title through a 304 (#571).
- **Crawlers.** `robots.txt` allows everything but `/sql/` and `/data/` and names two sitemaps (#355). `sitemap.xml` is built with the site from the pages folder, without the 404 page, `/sql/` and the player shell. `/sitemap-players.xml` is listed by the Worker from the current build's player files and served with an hour's cache, and once a build exists the edge keeps it for that hour (#593).
