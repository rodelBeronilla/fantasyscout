# 0002. Where ingestion runs

Date: 2026-10-27
Status: Accepted (option A, decided by the owner on 2026-10-27)

## Context

The spec plans ingestion as GitHub Actions cron jobs and warns that the league stats API is reported to block cloud and CI address ranges. Phase 1 measured it with `fs-ingest probe` (`.github/workflows/probe.yml`, run from a GitHub-hosted runner, and the same command from a residential connection).

| Source | GitHub-hosted runner | Residential connection |
| --- | --- | --- |
| stats.wnba.com `leaguegamelog` | TCP connects, no response, read timeout after 30 s, twice | 200 in about 1 s |
| stats.nba.com `leaguegamelog` | same | 200 in about 1.3 s |
| ESPN `scoreboard` (both leagues) | 200 | 200 |
| Databricks workspace (Unity Catalog API) | 200 | not tested (token is in Actions only) |

The block is silent: the server accepts the connection and never answers, so retries only burn time. Headers, pacing and backoff make no difference from that network.

## Options considered

**A. A self-hosted GitHub Actions runner on the home server for the stats API jobs.**
Schedules, logs, retries and incident issues stay in GitHub Actions exactly as designed; only the egress address changes. The runner is a container on a machine that is already on all day. ESPN and everything else keep running on GitHub-hosted runners. Costs: a runner to keep updated, and the stats jobs depend on the home machine being up. On a public repository a self-hosted runner must only run trusted workflows.

**B. ESPN as the live source, the stats API for backfill only.**
Daily runs stay entirely on GitHub-hosted runners, but the endpoints with no ESPN equivalent (shot x/y locations, tracking measures, the v3 box scores) would be fetched by hand for backfills, so shot charts and tracking tables would lag live play.

**C. A scheduled task on a personal computer, outside GitHub Actions.**
Works, but loses the shared logs, incident issues and run history that the rest of the platform reads.

## Decision

Option A. One self-hosted runner, a container defined in `infra/runner/compose.yml`, registered to this repository only with the label `home`. The `stats` job in `ingest.yml` targets `[self-hosted, home]` and runs only while the repository variable `STATS_RUNNER_LABEL` is set to that label; ESPN stays on GitHub-hosted runners.

## Consequences

- Shot, play-by-play, box score and roster data arrive daily from the stats API, with the same logs and incident handling as every other job.
- `ingest.yml` triggers on schedule and manual dispatch only, never on pull requests, and the repository requires approval before workflows from outside collaborators run. No other workflow targets the runner.
- The container stores no secrets; GitHub injects the Databricks host and the ingest's credential per job (since 2026-11-02 the service principal's client id and secret, see the addendum; before that a token). Jobs run as an unprivileged user with nothing mounted from the host.
- The runner's registration lives in a Docker volume, so restarts need no token. Re-registration after a wipe is documented in `infra/runner/README.md`.
- If the home machine is down, the stats job is queued until the runner returns; ESPN keeps running, so Data Health can still report freshness from the second source.

**Addendum (2026-11-02).** Two things changed since the decision. First, the backfill workflow's stats jobs target the same runner, so "no other workflow targets the runner" now reads: the ingest and the backfill do, nothing that runs on a pull request does. Second, the credential the runner's jobs hold is no longer the owner's token. The ingest and backfill jobs run as a Unity Catalog service principal (`fantasyscout-ingest`) that holds `USE CATALOG`, `USE SCHEMA` and `READ VOLUME, WRITE VOLUME` on the landing volume and nothing else; the jobs exchange its OAuth client id and secret (`DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`, environment secrets in `lakehouse`) for a one-hour access token at the workspace's token endpoint and renew it in-process (`ingest.store.ClientCredentials`), so a backfill that runs for hours keeps going and the home runner never holds a credential that could reach the warehouse. A token path (`DATABRICKS_INGEST_TOKEN`, minted on the principal's behalf by `infra/databricks/ingest-token.sh`) stays as the fallback; `DATABRICKS_TOKEN` is the last resort while both are unset. The runbook section "The ingest's own credential" has the setup. The change came in three steps: a token of the ingest's own, falling back to the owner's (#320); a script that mints it for the principal (#370); and the OAuth client credentials (#372). This addendum and the matching consequence bullet were written in #508.
