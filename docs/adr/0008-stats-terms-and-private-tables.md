# ADR 0008: The statistics' terms, source credit and the private tables

Status: accepted, 2026-10-29

## Context

Section 9 of NBA.com's terms covers "NBA Statistics", meaning statistics from NBA, WNBA and G League games served by the stats API we ingest. Under it the statistics:
- may be used only for legitimate news reporting or private, non-commercial purposes;
- must carry a prominent attribution to NBA.com;
- may not be used "in connection with any fantasy game or other commercial product or service";
- may not be used, without consent, by a site that features "a database (in any medium or format) of comprehensive, regularly updated statistics".

FantasyScout is free and non-commercial and publishes derived values (value above replacement, projections, tiers). But it also published the full gold tables as public Parquet behind an in-browser SQL console: every box score, play and shot, refreshed nightly. That is the database the terms describe. Facts are not copyrightable, but the terms are the operator's conditions for using its site and API.

## Options considered

1. **Credit only.** Keep publishing everything and rely on being free and non-commercial.
2. **Credit, and stop publishing the raw tables.** This drops the SQL console.
3. **Credit, and keep the raw tables private to the owner.** The derived surfaces stay public.

## Decision

Option 3, the owner's choice.

- **Credit.** Every page's footer credits NBA.com and WNBA.com for statistics and ESPN for schedules, rosters and injuries. It states that the site is free, non-commercial and unaffiliated with the leagues or ESPN.
- **Private tables.** The Worker serves Parquet under `/data/` only to the owner: a browser signed in with the owner's key, or CI sending it as a bearer token (`worker/src/owner.ts`).
  - The check runs on the decoded path, so an escaped name cannot get around it.
  - Without `OWNER_KEY` set, no one is served.
- **Sign-in.** Signing in posts the key once and sets an HMAC-signed, HttpOnly, Secure, SameSite=Lax cookie that lasts 30 days. A sign-in posted from another origin is refused.
- **Public surfaces.** The JSON the pages read stays public: board, streamers, player pages, Data Health and the manifest. So do the rendered notebooks, the Tableau extract and the dbt docs.
- **CI.** The notebooks and the Tableau extract read the published build with `FS_OWNER_KEY` (a DuckDB HTTP secret adding the header). The deploy copies `OWNER_KEY` from Actions secrets into the Worker.

## Consequences

- The SQL console is the owner's tool, and the public sees a sign-in form in its place.
- Fantasy use remains the open question. The site's purpose is fantasy analysis, which the terms name. It stays free, non-commercial and credited, and publishes analysis rather than the statistics themselves. If the operator objects, the site complies.
- New sources each get their own terms check before they are added (issues #126 to #129), and their credit joins the footer.
