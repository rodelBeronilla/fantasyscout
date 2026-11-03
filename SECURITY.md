# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub: **Security → Report a vulnerability** on this
repository. Please do not open a public issue for it. Include what you found, how to reproduce it,
and what it exposes; a proof of concept against your own copy is more useful than one against the
live site.

Reports are read by the repository owner. You will get an acknowledgement in the advisory thread,
and the fix ships as an ordinary release with the advisory published once it is live.

## What is in scope

- The site and its Worker (`web/`, `worker/`): the data endpoints under `/data/`, the owner-only
  routes (`/sql/`, the private tables, `/auth/`), the Yahoo league import, and the headers and
  Content-Security-Policy they send.
- The pipeline (`ingest/`, `dbt/`, `export/`, `ops/`) and its workflows (`.github/`): anything that
  would let a pull request, a crafted source payload or a third party reach a secret, write to the
  landing volume or the data bucket, or publish a build.
- The self-hosted runner setup in `infra/runner/`.

Out of scope: the data itself (it is the sources', under their terms; see the README), rate limits
on the public data files, and findings that need a compromised owner account or machine.

## Supported versions

The live site runs the latest commit on `main`; fixes go there and into the next release. Older
releases are not patched.
