# Self-hosted runner

The league stats API does not answer requests from GitHub-hosted runners (ADR 0002), so the `stats` jobs in `ingest.yml` and `backfill.yml` run on self-hosted runners with the label `home`: two containers defined in `compose.yml`, one per league, because stats.wnba.com and stats.nba.com are different hosts and each job makes one request at a time to its host. Concurrency groups (`stats-wnba`, `stats-nba`) keep two jobs from sharing a host. Everything else stays on GitHub-hosted runners.

## Start

```bash
RUNNER_TOKEN=$(gh api -X POST repos/rodelBeronilla/fantasyscout/actions/runners/registration-token --jq .token) \
  docker compose -f infra/runner/compose.yml up -d
docker logs -f fantasyscout-runner      # "Listening for Jobs" means it is registered
```

The registration token is valid for an hour and is used once; the runner's credentials then live in the `runner-state` volume, so restarts and reboots need nothing more than `docker compose up -d`.

Then set the repository variable `STATS_RUNNER_LABEL` to `home` (Settings → Secrets and variables → Actions → Variables). An empty variable skips the stats job.

## Security posture

- The runner is registered to this repository only, not to the account.
- `ingest.yml` triggers on schedule and manual dispatch only. No workflow that runs on a pull request targets this runner, and the repository requires approval before workflows from outside collaborators run.
- The container holds no secrets at rest. Job secrets are injected by GitHub per job and the only ones used are the Databricks host and token.
- Jobs run as the unprivileged `runner` user inside the container; nothing from the host is mounted.

## Maintain

- Update: `docker compose -f infra/runner/compose.yml pull && docker compose -f infra/runner/compose.yml up -d`. The runner also self-updates.
- Re-register after a token rotation or a wiped volume: `docker compose ... down -v`, then the Start steps.
- Remove: deregister with `./config.sh remove --token <remove-token>` (see `compose.yml`), then `down -v`.
