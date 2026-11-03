# 0001. Host FantasyScout on its own subdomain

Date: 2026-10-26
Status: Accepted

## Context

The first draft of `SPEC.md` assumed `beronilla.rodeo` was served by a Cloudflare Worker and that FantasyScout would be reached at `beronilla.rodeo/fantasyscout/` through a service binding in that Worker.

That is not how the site is hosted. `https://beronilla.rodeo/` is a handful of static files served by Caddy on a home server; DNS for the zone is at Cloudflare in DNS-only mode, so Cloudflare does not proxy the apex. There is no Worker to bind to. The question became: how should the app be reached, and how much should it share with the personal site?

## Options considered

**A. The home server's Caddy reverse-proxies `/fantasyscout*` to the Worker.**
Keeps the original URLs. Tried first and reverted: it needed the site's own security-header and cache rules carved around the prefix (two `Content-Security-Policy` headers blank the app), it tied the app's hostname to the Worker's `workers.dev` address, and it routed every request through the home connection, so the app's uptime followed the home server's.

**B. Caddy redirects `/fantasyscout*` to the Worker's own hostname.**
One stable line, but still a dependency between two unrelated deployments for the sake of a vanity path.

**C. Move the personal site behind Cloudflare and ship the Worker the spec described.**
Re-hosts a site that has no reason to change.

**D. Serve the app from the home server too, with R2 behind CORS.**
Loses single-origin `Range` streaming for DuckDB-WASM, per-build immutable caching, and the no-secrets-at-the-edge serving model.

**E. Give the app its own subdomain.**
Bind the Worker to `fantasyscout.beronilla.rodeo` as a Cloudflare custom domain. The zone is already on Cloudflare, so this proxies exactly one subdomain; Cloudflare creates the DNS record and certificate. Nothing in the personal site changes except, if wanted, a link.

## Decision

Option E. FantasyScout lives at `https://fantasyscout.beronilla.rodeo/` with the app at the root path. The Worker's production environment declares the custom domain in `worker/wrangler.toml`; the preview environment stays on `workers.dev`. The Worker keeps no `workers.dev` address in production so there is one canonical origin.

## Consequences

- Served entirely from Cloudflare's edge; no shared infrastructure, configuration or uptime with the personal site.
- The deploy token needs, on the `beronilla.rodeo` zone, Workers Routes (edit) and DNS (edit) in addition to the account-level Workers Scripts and R2 permissions, so the first production deploy can create the custom domain.
- The Astro app builds at base `/` and the Worker serves `/data/*` from R2; there is no path prefix to carry through every URL.
- The original `beronilla.rodeo/fantasyscout/` path does not exist. Links point at the subdomain.

## Addendum (2026-11-02): what a deploy ships, and the speed check after it

Two rules about the deploy grew in pull requests after this decision.

- **A deploy ships the build CI tested.** Deploy web runs when CI has passed on this repository's own push to `main` (production) or `preprod` (preview) (#502). It checks out the commit CI tested and takes that run's `web-dist` and `dbt-docs` artifacts, so the site is never built twice and nothing goes live that CI did not check (#312). A push that changed nothing under `web/`, `worker/`, `dbt/` or the deploy workflow is not deployed; `dbt/` joined the list so the dbt docs at `/docs/`, which ship in the same run, follow the project (#580). A manual dispatch builds the app and the docs on the spot. The runbook's "When the site deploys" has the details; ADR 0008's addendum of 2026-11-02 says what the docs are built from.
- **Which pages the speed budget holds.** After the deploy, Lighthouse (pinned version, mobile profile: simulated slow 4G and a 4x CPU slowdown) loads each page three times, and the 2 s budget applies to the median largest contentful paint (#86). It has measured three pages since #344. The home page (the Board) and the Schema page are enforced: a median over 2 s fails the run. Schema was only reported until #585 brought it under the budget. Streamers is measured and reported as a warning, not enforced (#564), until its largest paint is under the budget (issue #563). A second pass throttles for real and reads the pages' own `fs:first-row` mark on the home page and Streamers. It is reported against 1.8 s and never fails the run (#539). Both checks run against the deployed Worker, so a failure turns the run red; it does not hold the new version back.
