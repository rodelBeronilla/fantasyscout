# 0002. Where ingestion runs

Date: 2026-10-27
Status: Proposed (awaiting the owner's choice between A and B below)

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
Schedules, logs, retries and incident issues stay in GitHub Actions exactly as designed; only the egress address changes. The runner is a container on a machine that is already on all day. ESPN and everything else keep running on GitHub-hosted runners. Costs: a runner to install and keep updated, and the stats jobs depend on the home machine being up. On a public repository a self-hosted runner must only run trusted workflows: the ingest workflow triggers on schedule and manual dispatch only (never on pull requests), and the repository setting that requires approval for workflows from outside collaborators stays on.

**B. ESPN as the live source, the stats API for backfill only.**
Daily runs stay entirely on GitHub-hosted runners. The stats API endpoints that have no ESPN equivalent (shot x/y locations, tracking measures, the v3 box scores) would be fetched by hand from a residential machine for backfills, so the shot charts and tracking tables would lag live play.

**C. A scheduled task on a personal computer, outside GitHub Actions.**
Works, but loses the shared logs, incident issues and run history that the rest of the platform reads.

## Recommendation

Option A. It keeps the orchestration story intact and is the only option that keeps shot and tracking data fresh. The workflow is already written for it: the stats job runs only when the repository variable `STATS_RUNNER_LABEL` names the runner's label, so turning it on is configuration, not code.

## Decision

Pending.

## Consequences (if A)

- Install the GitHub Actions runner on the home server as a container with labels `self-hosted` and the chosen label, registered to this repository only.
- Set `STATS_RUNNER_LABEL` in Settings → Secrets and variables → Actions → Variables.
- Keep `ingest.yml` free of `pull_request` triggers and keep the "require approval for all outside collaborators" setting on.
- The runbook gains a section for re-registering the runner after a token rotation or a machine rebuild.
