# ADR 0007: Importing a Yahoo Fantasy league

Status: accepted, 2026-10-29

## Context

The League page keeps a manager's league: its settings, its team names and every roster. Typing twelve rosters in by hand is the slowest part of setting it up. Yahoo's Fantasy Sports API can supply all three, but only for a signed-in manager. It uses OAuth 2.0, and its token endpoint needs the app's client secret.

That rules out the browser alone:
- the client secret cannot ship in a public page;
- Yahoo's API does not answer cross-origin requests from another site.

SPEC.md also says the Worker holds no secrets and reads only public, exported data.

## Options considered

1. **A paste box only.** Rosters copied from the league's site and matched by name. This needs no secrets, so it is built either way. It still means twelve copy-and-paste rounds, and the settings are typed in by hand.
2. **An import in GitHub Actions** with a refresh token stored as a repository secret. This works only for the owner's own leagues, and it would publish their rosters into the public build.
3. **The Worker as a thin OAuth client.** It holds the client id and secret as Worker secrets, signs the manager in, and reads their league on their behalf.

## Decision

Option 3, alongside the paste box.

- **Routes.** `/auth/yahoo/start`, `/auth/yahoo/callback` and `/auth/yahoo/logout` handle the sign-in. `/api/yahoo/status`, `/api/yahoo/leagues` and `/api/yahoo/league/<key>` are read-only GET routes that return only what the League page needs (`worker/src/yahoo.ts`).
- **Tokens never reach the page.** They are kept in an HttpOnly, Secure, SameSite=Lax cookie, encrypted with AES-GCM under a key derived (HKDF) from the client secret. Rotating the secret invalidates every cookie. An expired access token is refreshed on the next request.
- **The sign-in is checked.** It carries a random state value, held in a short-lived cookie and compared on the callback.
- **No server-side storage.** The league goes straight into the browser's League page and into nothing else.
- **NBA only.** Yahoo has no WNBA game.
- **Off by default.** The deploy workflow copies `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET` from Actions secrets into the Worker only when both are set. Without them every route answers "not configured" and the League page hides the card.

## Consequences

- The Worker now holds two secrets, which supersedes SPEC.md's "no secrets in the Worker" for this optional feature. Everything it serves from R2 is still public and exported, and its other routes are unchanged.
- The tests run the whole sign-in and both parsers against a stand-in for Yahoo, so CI needs no Yahoo account (`worker/test/yahoo.test.ts`). The import page has a Playwright test against stubbed routes.
- The redirect URI registered with Yahoo is the production one. The preview Worker cannot complete a sign-in, so the import is verified on production after the secrets are added.

## Addendum (2026-10-31): a bookmarklet while the API approval is pending

Yahoo's Fantasy API answers 403 until it approves the app, so the import is parked. Rosters still come in without the API: a bookmarklet on the League page runs on the manager's own Yahoo league page, in their signed-in browser. It finds the league id in the address, reads each team's roster page the way the browser would (same-origin fetches with the manager's cookies), takes team names from the league's team links and player names from the player links, notes which team the page calls "My Team", and opens the League page with that data after the `#` in the address. The fragment never reaches a server. The League page matches the names to players (`matchNames`, the same as the paste path), fills the rosters, sets the manager's team and lists any name it could not match.

Nothing is fetched by FantasyScout's servers and nothing is stored beyond the browser, so Yahoo's terms on automated access are not engaged the way an API or a scraper would engage them. The bookmarklet is built against the patterns of Yahoo's pages (team links `/nba/<league>/<team>`, player links to `sports.yahoo.com/nba/players/`); if Yahoo changes them it reports that no rosters were found, and the paste path remains. React refuses `javascript:` links, so the link's address is set on the element directly, and it is dragged to the bookmarks bar rather than clicked.

