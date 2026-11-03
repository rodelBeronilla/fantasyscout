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
- Jobs run as the unprivileged `runner` user inside the container; nothing from the host is mounted; `no-new-privileges` is set, so nothing in a job can gain privileges it did not start with.
- The runner is registered with `--disableupdate`, so it does not update itself. Note that the runner's files live in the `runner-state` volume mounted over `/home/runner`: a volume keeps the runner binaries it was first filled with, so a new image digest changes the runner only after the volume is recreated (`down -v` and re-register, "Update the runner image").
- Egress goes through an allow-list (next section). Each runner sits alone with the egress proxy on an internal network: no gateway, so no route to the internet, the host, the LAN or the other runner except through the proxy.
- The runners are persistent, not ephemeral: the work folder and the tool caches live in the `runner-state` volumes between jobs. An ephemeral runner (a fresh registration per job) needs a host-side loop that mints a registration token for every start; that is the next hardening step and it runs on the host, not in this repository.

## Egress

The runners reach the outside only through `egress-proxy` (Squid, pinned by digest), the one container on both their internal networks and a network with a route out. `squid.conf` forwards to the hosts the stats jobs need and refuses everything else:

- GitHub (`.github.com`, `.githubusercontent.com`, and the Actions storage under `.blob.core.windows.net`): the runner's own connection, checkout, the cache, artifacts and logs, release downloads, the incident action;
- `releases.astral.sh`, `pypi.org`, `files.pythonhosted.org`: uv and the Python packages;
- `stats.nba.com`, `stats.wnba.com`: the league stats API (ADR 0002);
- `.cloud.databricks.com`: the workspace (the ingest's OAuth token and the Files API).

A private, loopback or link-local address is refused even behind an allowed name, so a name that resolves into the LAN gets nowhere. The runners carry `HTTPS_PROXY`/`HTTP_PROXY` (both cases) pointing at the proxy; a step that ignores them simply has no route. Every request, allowed or refused, is in the proxy's log:

```bash
docker exec fantasyscout-egress-proxy tail -50 /var/log/squid/access.log    # TCP_TUNNEL = allowed, TCP_DENIED = refused
```

A job that needs a new host fails with the host's name as `TCP_DENIED` in that log; add it to `squid.conf` in a PR and `docker compose -f infra/runner/compose.yml up -d` from the main checkout.

## The language model

Phase 7's notes are drafted by a local model (ADR 0017): the `ai` service runs Ollama on the GPU, on the runners' internal networks only. A job reaches it at `http://ai:11434` (`FS_AI_URL`; `ai` is in the runners' `NO_PROXY`), and the service itself has no route out, so it cannot fetch anything at run time. The model lives in the external volume `fantasyscout-ai-models` and is pulled once, on a container that does have a route out:

```bash
docker volume create fantasyscout-ai-models
docker run -d --name fs-ai-pull -v fantasyscout-ai-models:/root/.ollama ollama/ollama@sha256:5d3a2f25f9825628daba94dc0b1d421c7d57d6c03ae5faa9ba050e058bab8241
docker exec fs-ai-pull ollama pull qwen3:8b
docker rm -f fs-ai-pull
docker compose -f infra/runner/compose.yml up -d ai
docker exec fantasyscout-ai ollama list    # qwen3:8b
```

A new model is the same pull with its name, and `FS_AI_MODEL` in the notes workflow. The service answers one request at a time and unloads the model after five idle minutes, so it shares the GPU with the server's other work.

## Live answers

The Trade page's "Explain this trade" (ADR 0017, `worker/src/ai.ts`) reaches the model through a Cloudflare Tunnel. Only the Worker can pass it: an Access application in front of the tunnel's hostname admits nothing but the Worker's service token. Once, in the Cloudflare dashboard (Zero Trust):

1. **Tunnel.** Networks → Tunnels → Create a tunnel (cloudflared), named `fantasyscout-ai`. Copy its token. Add a public hostname, e.g. `ai.<your zone>`, with service `http://ai:11434`.
2. **Service token.** Access → Service Auth → Create a service token, `fantasyscout-worker`. Copy its client id and secret: they are shown once.
3. **Access application.** Access → Applications → Add a self-hosted application on the tunnel's hostname, with one policy: action **Service Auth**, include the service token. Nothing else gets through.
4. **Secrets, in your own terminal or the GitHub UI, never in a chat or a file in the repository:**
   - `gh variable set AI_URL --body https://ai.<your zone>`;
   - `gh secret set AI_ACCESS_CLIENT_ID`, and `gh secret set AI_ACCESS_CLIENT_SECRET`;
   - the next web deploy gives them to the Worker.
5. **Start the tunnel**, with its token in the shell's environment rather than in a file: `AI_TUNNEL_TOKEN=<token> docker compose -f infra/runner/compose.yml --profile live up -d ai-tunnel` from the main checkout.

`/api/ai/status` then says `available: true`. A signed-in manager gets four explanations a minute. The tunnel reaches the model on `ai-live` and Cloudflare's edge on the `egress` network; the runners never touch either.

## What is still open

Ephemeral registration (a fresh registration for every job) needs a host-side loop that mints a registration token for every start, so a credential that can register runners would live next to them; it is left out until a narrowly scoped token and supervisor justify it. The protections today: the fork approval policy on the repository, no workflow on a pull request targeting the `home` label, the unprivileged user, no host mounts in the runners, no privilege escalation, the pinned image with self-update off, and egress through the allow-listed proxy only.

## Monitor

GitHub cannot tell the workflows that a self-hosted runner is gone: a stats job just queues, for up to a day, and nothing reports. Two things watch for that. On the host, `check.sh` asks GitHub for the runners' status and Docker for the containers' health, and opens, updates or closes the "Home runner offline" incident issue the same way a failed job does; run it from cron every half hour with `gh` signed in to a fine-grained token for this repository with Administration: read (the runners' status) and Issues: write (the incident), not a classic `repo` token:

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

- Update: `docker compose -f infra/runner/compose.yml pull && docker compose -f infra/runner/compose.yml up -d`. The runner does not self-update (`--disableupdate`). The proxy's image updates this way; the runner's binaries come from its volume, so a new runner version takes `down -v` and re-registration (Start).
- Run `docker compose ... up -d` from the main checkout, not a worktree: the proxy mounts `squid.conf` from the directory it was started in.
- Apply this file's changes to running containers with `docker compose -f infra/runner/compose.yml up -d` (the network is created on the way; a registration made before `--disableupdate` keeps working, and the flag takes effect at the next `config.sh`, i.e. after a `down -v` and re-registration).
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

