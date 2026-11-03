# 0016. Accounts for league setups

Date: 2026-11-03
Status: Accepted

## Context

A manager's league setup (settings, punts, focus, rosters, this week's opponent) lived only in the browser's `localStorage`. Changing device or browser, or clearing site data, lost it, and a manager who uses the board on a phone and the Trade page on a laptop had to keep two copies by hand (#684). The site already signs the owner in with Yahoo (ADR 0008) and asks a Yahoo user to sign in for the league import (ADR 0007).

## Options considered

1. **Browser only (the status quo).** Nothing about a visitor on the server, but no way to carry a league across devices.
2. **Export and import a file.** No server state, but a manual step on every change.
3. **An account behind the Yahoo sign-in (chosen).** Any Yahoo user can sign in. The Worker stores each league's setup per account, and the browser and the account keep each other current.

## Decision

Option 3 (`worker/src/account.ts`, `web/src/lib/account.ts`).

- **Who.** Any Yahoo account. The sign-in is the owner's OpenID flow (`/auth/account/start`, state `account-<league>-…`), and it sets an account cookie for every account. The owner also gets the owner's cookie.
- **The id.** `HMAC-SHA256(client secret, "account:" + Yahoo id)`, first 32 hex characters. The Yahoo id itself is never stored. The cookie (`fs_account`, HttpOnly, Secure, SameSite=Lax, 90 days) carries the id and its expiry, signed with the same secret.
- **Storage.** One JSON object per account and league in the existing R2 bucket, at `private/accounts/<id>/<league>.json`, holding `{ setup, savedAt }` (256 KB at most). The `/data/` route answers 404 for anything under `private/`, so the public bucket route never serves it. No new binding or service is needed.
- **Sync.** Each copy carries the time it was saved, and the newer one wins. On the first read of a page, an account copy newer than the browser's replaces it; a browser copy newer than the account's is sent to the account. Each edit is saved locally at once and to the account after a pause of 0.8 s.
- **Writes.** `PUT /api/account/setup` and `DELETE /api/account` are the Worker's only write routes. They require the session cookie and a same-origin `Origin` header.
- **Deletion.** "Delete my saved data" on the League page deletes every object under the account's prefix and clears the cookie. The browser keeps its own copy.

## Consequences

- The site now stores visitor data: league setups (team names the manager typed, player ids, settings) under a pseudonymous id. The architecture's "Data retention and privacy" section and the Sources page say so. The data is kept until the visitor deletes it.
- Without the Worker (the preview server, the Playwright tests) the status route does not answer, nobody is signed in, and setups stay in the browser as before.
- Losing the Yahoo client secret orphans the stored setups: a new secret derives new ids. Rotating the secret is therefore also a reset of every account.
