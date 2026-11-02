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
- The container holds no secrets at rest. Job secrets are injected by GitHub per job and the only ones used are the Databricks host and the ingest service principal's client id and secret (runbook, "The ingest's own credential"), which can write the landing volume and nothing else.
- Jobs run as the unprivileged `runner` user inside the container; nothing from the host is mounted.

## Monitor

GitHub cannot tell the workflows that a self-hosted runner is gone: a stats job just queues, for up to a day, and nothing reports. Two things watch for that. On the host, `check.sh` asks GitHub for the runners' status and Docker for the containers' health, and opens, updates or closes the "Home runner offline" incident issue the same way a failed job does; run it from cron every half hour with `gh` signed in to a token that has the `repo` scope:

```cron
*/30 * * * *  /path/to/fantasyscout/infra/runner/check.sh >> /var/log/fantasyscout-runner.log 2>&1
```

Independently, the Publish watchdog (`docs/runbook.md`, "Publish SLA and the watchdog") notices a site whose build is overdue, whatever stopped it, and the Build workflow opens an incident when an ingest run was cancelled for want of a runner. Each container also has a Docker healthcheck (the runner process listening for jobs), so `docker ps` shows `healthy` or `unhealthy` and `restart: unless-stopped` brings a crashed container back.

## Runner shows offline

1. `docker ps -a --filter name=fantasyscout-runner` and `docker logs --tail 50 fantasyscout-runner` (or `-2`). "Listening for Jobs" means registered and connected; a loop of registration errors means the credentials in the volume no longer match GitHub (the runner was removed from the repository, or the volume was recreated).
2. A stopped container: `docker compose -f infra/runner/compose.yml up -d`. An unhealthy one: `docker compose -f infra/runner/compose.yml restart runner-1` (or `runner-2`).
3. Registration lost: `docker compose -f infra/runner/compose.yml down -v`, then the Start steps with a fresh registration token. The two runners are independent; one can be re-registered while the other keeps working.
4. GitHub lists the runner online but jobs still queue: the label (`home`) or `STATS_RUNNER_LABEL` changed, or the job's concurrency group is held by a run that hung (cancel it from the Actions tab; the job time limits release it within two hours anyway).

## Maintain

- Update: `docker compose -f infra/runner/compose.yml pull && docker compose -f infra/runner/compose.yml up -d`. The runner also self-updates.
- Re-register after a token rotation or a wiped volume: `docker compose ... down -v`, then the Start steps.
- Remove: deregister with `./config.sh remove --token <remove-token>` (see `compose.yml`), then `down -v`.

## Update the runner image

`compose.yml` pins the runner image to a version and a digest, so the host never pulls an image nobody looked at. To move to a newer runner:

```bash
ver=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | python -c "import json,sys; print(json.load(sys.stdin)['tag_name'].lstrip('v'))")
tok=$(curl -s "https://ghcr.io/token?scope=repository:actions/actions-runner:pull" | python -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -sI -H "Authorization: Bearer $tok" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/actions/actions-runner/manifests/$ver" | grep -i docker-content-digest
```

Put `<ver>@<digest>` in `compose.yml`, open a PR, then on the host `docker compose -f infra/runner/compose.yml pull && docker compose -f infra/runner/compose.yml up -d`. The runner's own self-update stays on; the image pin decides what the container starts from.

