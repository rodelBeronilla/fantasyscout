# Contributing

FantasyScout is a solo project, so this file is less about etiquette and more about how the repo is kept honest.

## AI in development

Claude Code was used to build this repository. It was kept honest the same way any contributor is:

- Tests are written or reviewed before a change merges, and no live API calls happen in tests (fixtures are recorded).
- Every real design decision gets an ADR in `docs/adr/`, written when the decision is made, not after.
- No generated code merges without a passing CI run.
- Work lands as small, reviewed pull requests, not one large dump. The commit history is the audit trail.
- When the spec and reality disagree, the disagreement is written down (an ADR) rather than papered over.

No number shown on the site comes from a language model. See "AI usage" in `SPEC.md`.

## Workflow

1. Branch from `main`: `ai/feat/<issue>-short-name`, `ai/fix/<issue>-short-name`.
2. Small commits in conventional-commit form: `type(scope): description`.
3. Open a pull request using the template. Link the issue (`Closes #NN`) and add a `release:*` label.
4. CI must be green: lint, unit tests, dbt build on DuckDB (from phase 2), notebook execution (from phase 6), web build and Playwright.
5. The owner reviews and merges. `preprod` deploys the preview Worker; `main` deploys production.

## Local checks

Python (needs [uv](https://docs.astral.sh/uv/)):

```bash
uv sync
uv run ruff check . && uv run ruff format --check .
uv run mypy
uv run pytest
```

Web (needs Node 24):

```bash
cd web
npm ci
npm run check && npm run lint
PUBLIC_BUILD_ID=local npm run build
npx playwright install chromium   # once
npm test
```

Worker (build the web app first; the tests serve the real `web/dist`):

```bash
cd worker
npm ci
npm run typecheck
npm test
npm run check   # wrangler deploy --dry-run for both environments, no credentials needed
```

On Windows, Cloudflare's local runtime (workerd) needs the Microsoft Visual C++ Redistributable installed. Without it `wrangler dev`, `wrangler types` and the Worker tests fail with `write EOF`; everything else, including the dry-run deploy, still works. `docs/runbook.md` has a container alternative.

## Standards

- Python 3.12, `ruff` for lint and format, `mypy --strict` on `ingest/` and `export/`, `pytest`.
- SQL models are dbt models with descriptions and tests; `sqlfluff` with the dbt templater (from phase 2).
- Web is TypeScript strict, ESLint, Playwright smoke tests and an axe accessibility check on every page.
- Secrets come only from environment variables or GitHub Actions secrets. Never print, log or commit them.
