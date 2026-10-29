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
- **Private tables.** The Worker serves Parquet under `/data/` only to the owner (`worker/src/owner.ts`). The check runs on the decoded path, so an escaped name cannot get around it.
- **Sign-in with the owner's Yahoo account.** No password exists to manage. The Yahoo app from ADR 0007 provides OAuth sign-in even while its Fantasy API access is pending.
  - Yahoo's token response names the account (`xoauth_yahoo_guid`), and only `OWNER_YAHOO_GUID` (a repository variable) gets the owner's cookie: HMAC-signed, HttpOnly, Secure, SameSite=Lax, 30 days. No Yahoo token is kept.
  - Any other account is shown its own id, which is how the owner learns theirs the first time.
  - The sign-in shares the app's one registered redirect URI with the league import, and a state cookie marks the owner's sign-ins.
- **CI's reader key.** CI cannot sign in to Yahoo, so it reads with a key derived from the Yahoo client secret it already holds: HMAC-SHA256(secret, "fantasyscout ci reader"). Rotating that secret rotates the key. Without the Yahoo credentials, no one is served.
- **Public surfaces.** The JSON the pages read stays public: board, streamers, player pages, Data Health and the manifest. So do the rendered notebooks, the Tableau extract and the dbt docs.
- **CI.** The notebooks and the Tableau extract read the published build with `FS_READER_SECRET` set to the Yahoo client secret; `notebooks/fs.py` derives the reader key and adds it to DuckDB as an HTTP secret. The deploy copies the Yahoo credentials into the Worker and passes `OWNER_YAHOO_GUID` as a variable.

## Consequences

- The SQL console is the owner's tool, and the public sees a "Sign in with Yahoo" button in its place.
- Private access depends on the Yahoo app existing. If it goes, a stored key could replace the sign-in without changing which data is private.
- Fantasy use remains the open question. The site's purpose is fantasy analysis, which the terms name. It stays free, non-commercial and credited, and publishes analysis rather than the statistics themselves. If the operator objects, the site complies.
- New sources each get their own terms check before they are added (issues #126 to #129), and their credit joins the footer.

## Addendum (2026-10-29): the owner signs in with OpenID

The plain OAuth sign-in returned no account id for this Yahoo app (no `xoauth_yahoo_guid`), so it could not tell the owner from anyone else. The owner's sign-in now always asks Yahoo for the `openid` scope. The account is the OpenID token's subject, or failing that the subject from Yahoo's OpenID user info. The plain sign-in is gone. `OWNER_YAHOO_GUID` may be an Actions secret or a repository variable.
