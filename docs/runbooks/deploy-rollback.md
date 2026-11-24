# Deploy and rollback: FantasyScout

The exact commands, gathered in one place. The full procedures they come from are in [docs/runbook.md](../runbook.md); where the two disagree, fix one in the same pull request. Rehearsed once to reach L2: record the rehearsal date here and in `.sdlc/factory.yml`.

Last rehearsed: never as a planned drill (TBD). The pieces have run for real: Worker versions on every deploy, data rollback by pointer since phase 5, and the DuckDB fallback publishing since 2026-11-20 (#1043).

There are two things that deploy, and they roll back separately:

| What | Deployed by | Rolled back by |
| --- | --- | --- |
| The web app and Worker | `deploy-web.yml`, after CI passes on this repository's own push to `main` (production) or `preprod` (preview) | `wrangler rollback` to an earlier Worker version |
| The data build | `build.yml` (or `build-fallback.yml`) after each ingest, through the publish gate, to the R2 bucket `fantasyscout-data` | The Export data workflow's `rollback` action (the `latest.json` pointer) |

## Preconditions

- The pull request is merged on `main` by `tools/dev/merge-pr.sh <pr>` (it waits for every check, squash-merges, then resets `preprod` to `main`). A merge needs the branch up to date with `main`. Add `--keep-preprod` while someone is still checking a preview on `preprod` (source: handoff-fantasyscout.md:9, 2026-11-22).
- Who may merge which change is the merge rule in `.sdlc/state.md`.
- `preprod` holds one change a manager would see at a time; merging resets it, so merge the previewed pull request before any other.

## Preview

```bash
git push --force-with-lease=preprod:origin/preprod origin <branch>:preprod   # only the session running the review does this
```

CI runs on `preprod`, then Deploy web publishes https://fantasyscout-preview.rodel-beronilla.workers.dev and runs the same Lighthouse gate as production; the deploy log's "median LCP" lines give the numbers.

## Deploy

Production deploys itself: the merge to `main` runs CI, and Deploy web ships the very `web-dist` artifact CI tested. A push that touched nothing under `web/`, `worker/`, `dbt/` or the deploy workflow is not deployed. To deploy without a CI run: Actions → Deploy web → Run workflow on the branch.

## Verify

```bash
gh run list --workflow deploy-web.yml --branch main -L 3                         # the merge's deploy concluded success
curl -sI https://fantasyscout.beronilla.rodeo/ | head -1                           # 200
curl -sI https://fantasyscout.beronilla.rodeo/ | grep -ci content-security-policy  # 1
curl -s  https://fantasyscout.beronilla.rodeo/data/latest.json                     # build_id and data_as_of are recent
```

Pass means: the deploy run is green (its Lighthouse gate holds home and Schema under a 2 s median LCP), the site answers 200 with its CSP, and the page the change touched shows what its bar says, checked on the live site (at 390 px wide too when the change is about a phone). Deploys have gone red unnoticed while merging before (2026-11-02, #623, #630): read the deploy conclusion after every merge. If any check fails, roll back first, then investigate.

## Rollback: the web app

Either revert the merge (preferred: it goes through CI and the same deploy):

```bash
git revert <merge sha>      # on a branch, as a pull request; it merges under the same rule
```

or roll the Worker back at once, from `worker/` with the deploy token in the environment (owner: the token is the `CLOUDFLARE_API_TOKEN` secret, never copied out of GitHub):

```bash
npx wrangler versions list --env production
npx wrangler rollback --env production      # pick the version before the bad deploy, or pass its id
```

How to find the previous version: `wrangler versions list` shows each deploy with its time; match it to the deploy run of the merge before. Rolling the Worker back does not touch the data.

## Rollback: a data build

Actions → Export data → Run workflow, action `rollback`; leave the build id blank to go back one build, or give one from the `list` action. The site serves it within a minute. A rollback pins the site: nightly builds keep publishing files but do not go live until the action `unpin` runs. Locally:

```bash
uv run fs-export list --store r2
uv run fs-export rollback --store r2 [--to <id>]
uv run fs-export unpin --store r2 [--to <id>]
```

Seven builds are kept. A rollback refuses a build that lost its manifest or key list (`list` marks it `incomplete`). An Export run that rolls back or ignores the gate runs in the `lakehouse-override` environment, which waits for the owner's approval.

## Live-only state a deploy touches

- **Worker secrets** (`YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `OWNER_YAHOO_GUID`, `CI_READER_KEY` and the three `AI_*` names) are written by the deploy with `wrangler secret bulk` from the GitHub secrets of the same names. Whether a Worker rollback also restores the earlier secret values is TBD (not tested here).
- **R2 bucket `fantasyscout-data`**: the deploy creates it if missing and uploads the DuckDB-WASM files once per version; it never deletes.
- **The custom domain** `fantasyscout.beronilla.rodeo` was created by the first production deploy; DNS is at Cloudflare.
- Nothing on the home machine changes on a deploy. The home runners, the egress proxy and the four Windows tasks change only by hand, and only the owner does that (`infra/runner/README.md`, `infra/host/README.md`).

## Restore from backup

There is no backup of the raw landing volume (`/Volumes/fantasyscout/raw/landing` in the Databricks workspace), and the observed-only feeds from late October 2026 on cannot be fetched again. Published builds can be restored only within the seven kept. A plan and a first restore drill are TBD (question for the owner; #1149).
