# Runbook

Operational procedures. Each section is a checklist someone can follow at 3 a.m. Sections marked "phase N" are filled in when that phase lands.

## First deploy (phase 0)

1. In Cloudflare, create an API token (My Profile → API Tokens → Create Custom Token) with:
   - Account → Workers Scripts → Edit
   - Account → Workers R2 Storage → Edit
   - Zone → Workers Routes → Edit, and Zone → DNS → Edit, both limited to the `beronilla.rodeo` zone (the custom domain is created on the first production deploy)
   Note the Account ID from Workers & Pages → Overview.
2. In the GitHub repo, add Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets and variables → Actions). Never put them anywhere else.
3. Enable R2 on the account once (dashboard → R2; it asks for a payment method even though the free tier covers this project). The deploy workflow creates the `fantasyscout-data` bucket itself if it is missing.
4. Preview: push `main` to `preprod` (or run the "Deploy web" workflow on `preprod`). The workflow prints the `workers.dev` URL and smoke-tests `/`.
5. Production: merge to `main`. The first run creates the custom domain `fantasyscout.beronilla.rodeo`; DNS and the certificate can take a minute, which the smoke test waits for.
6. Smoke test by hand:
   ```bash
   curl -sI https://fantasyscout.beronilla.rodeo/ | head -1                      # HTTP/2 200
   curl -s  https://fantasyscout.beronilla.rodeo/ | grep -o 'Build <code[^<]*</code>'
   curl -sI https://fantasyscout.beronilla.rodeo/data/latest.json | head -1      # 404 until the first export
   curl -sI https://fantasyscout.beronilla.rodeo/ | grep -ci content-security-policy   # 1
   ```

## Roll back a web deploy

Workers keep previous versions. From `worker/` with the token in the environment:

```bash
npx wrangler versions list --env production
npx wrangler rollback --env production      # interactive pick, or pass the version id
```

Rolling back the Worker does not touch R2 data; data rollback is a separate step (phase 5, `latest.json` pointer).

## Rotate a key

1. Create the new token or key at the provider.
2. Update the GitHub Actions secret. Re-run the latest deploy or build workflow to prove the new value works.
3. Revoke the old one at the provider. Check the next scheduled run is green.

## Run the checks locally

See `CONTRIBUTING.md`. On Windows, Worker tests need the Visual C++ Redistributable for workerd; otherwise run them in a Linux container (the slim image lacks the CA certificates workerd needs):

```bash
docker run --rm -v "C:\path\to\fantasyscout:/repo:ro" -w /w node:24-bookworm bash -c \
  'mkdir -p /w/web && cp -r /repo/web/dist /w/web/dist && cp -r /repo/worker /w/worker && cd /w/worker && rm -rf node_modules && npm ci && npm test'
```

## Backfill (phase 1)

To be written with the ingestors.

## Rerun a day (phase 1)

To be written with the ingestors.

## Roll back a data build (phase 5)

To be written with the export job.

## When a source changes shape (phase 1)

To be written with the ingestors.
