# 0014. Platform conventions and retention

Date: 2026-11-02
Status: Accepted

## Context

Some decisions made between 2026-10-28 and 2026-11-02 apply across the platform rather than to one component. Until now they were recorded only in the descriptions of the pull requests that made them, or, for retention, only in `docs/architecture.md` (issue #477). This record collects them as the code has them on 2026-11-02, each with the PR that made it. Decisions about the deploy, the Worker and the ingest's credential went to addenda of ADRs 0001, 0006, 0008 and 0002. The release procedure and the Dependabot re-lock policy are in the runbook, and the licence is in the README.

## Options considered

The PRs record no alternatives for these conventions. Each was adopted to close a gap that an issue described, and the sections below name the gap where the PR did.

## Decision

### Retention

Before #349, only the builds' retention (seven) was stated. The landing volume had none, and ADR 0008's promise to delete landed files on an objection had no procedure. #349 wrote the policy down. The table in `docs/architecture.md` ("Data retention and privacy") is the full statement, and the site's `/sources/` page mirrors it. In short:

- **Published builds**: the newest seven (`KEEP_BUILDS`), plus any build a rollback pinned. Pruning follows each promotion and never removes the live build or a pinned one. A staged build that has not gone live within two days is removed by the next promotion's prune (#548).
- **Landing volume**: kept indefinitely, as the record of what each source said each day. Pruning superseded snapshots is written down for when the volume passes 50 GB (ADR 0004).
- **Lakehouse tables**: rebuilt from the landing on every build. `fct_board_history` and the ops ledgers grow by one row a day and are never pruned.
- **Notebook findings history**: the newest 90 builds per notebook and league (below).
- **Visitors**: a visitor's settings live in their own browser's storage (below). Since ADR 0016, a visitor who signs in with Yahoo can save their league setups to an account; those are kept until the visitor deletes them on the League page.
- **Removal on request**: the runbook's "Remove a source on request" (#349).

### Column conventions on the Schema page

#354 states the column conventions once, in `CONVENTIONS` in `ops/schema.py`, and the Schema page shows them:

- **Dates**: a `*_date` column is the Eastern game date; a UTC date says so in its name, `*_date_utc` (#615), and bronze keeps a source's own field names.
- **Instants**: a `*_at` or `*_datetime_utc` column is in UTC unless its `tz` says otherwise.
- **Units**: minutes, miles, inches, pounds, ratios from 0 to 1, milliseconds, and `*_pg` per game played.
- **Nulls**: null means not known or not applicable, never zero.

A column that departs from a convention says so in its dbt `meta`: `tz`, `unit` or `null_when`, each shown as a badge. CI runs `python -m ops.schema --check --require-docs`, which fails when:

- an exported gold column has no description;
- an exported model is missing from the dbt project;
- a column that the per-league JSON files export is not a column of its model (#176);
- a timestamp column has no `meta.tz` (#354).

### Versioned browser storage

#341 replaced storage keys that had no common form, and a league-setup "migration" that did not know which shape it was reading.

- Everything the site keeps in a visitor's browser lives under one namespace, `fantasyscout:<thing>` or `fantasyscout:<thing>:<league>` (`web/src/lib/storage.ts`). Every read and write is guarded, because storage can be missing or blocked.
- A value under an older key moves to its current key the first time it is read. The theme and the league choice moved this way.
- The stored league setup carries a `version` (`SETUP_VERSION` in `web/src/lib/fantasy-league.ts`, 3 since #527). `migrate` walks an object one version at a time to the current shape, and treats an object without a version as version 1. An object from a newer build keeps what this build understands. A migrated setup is written back in its current shape.
- Any change to what is stored raises the version and adds the step to `migrate`, as the doc comment on `SETUP_VERSION` says. A vitest table of old payloads (`fantasy-league.migrate.test.ts`) loads every earlier shape, plus a newer build's shape.

### Quality thresholds, defined once

#352 moved the thresholds that the warn checks and the data-quality notebook grade against into one place, `vars.quality_thresholds` in `dbt/dbt_project.yml`. Each is a `[good, ok]` pair, except one count (`team_turnovers_max`). A warn check warns past the good bound, and notebook 04 grades its table from the same values, so the notebook and the checks cannot drift apart. These checks read them:

- `warn_crosswalk_coverage` (#352);
- `warn_reconciliation_conflicts` (#547);
- `warn_injury_links`, `warn_lineup_completeness` and `warn_team_turnovers` (#610).

A new threshold goes into the var, not into a test's SQL.

### The findings history

The findings a build's notebooks publish are pruned with the build after seven builds. #352 keeps them longer. After each promotion, `fs-export findings-history` (run by the publish-build action and the Export workflow) adds one entry per build, notebook and league to `notebooks/findings-history.json` at the bucket's root: the headline, the evidence count and the facts. A build that runs twice replaces its own entry. The Notebooks page shows the history, and the Worker serves the file with the pointers' minute (ADR 0006).

The history keeps the newest 90 entries per notebook and league (`FINDINGS_HISTORY_KEEP` in `export/build.py`). #352's description says 60, but the code it merged keeps 90, and so does the code today.

### Releases

#345 made versions tags of the form `vMAJOR.MINOR.PATCH` on `main`, cut by the manual Release workflow. Release notes are generated from the `release:*` label that every PR carries (`.github/release.yml`: breaking changes, features, fixes, other). PRs labelled `release:skip` or `dependencies` are left out. Each release names the data build the site was serving when it was cut, and opens a PR that bumps `pyproject.toml` unless the file already has that version (#357). The procedure is the runbook's "Cut a release".

## Consequences

- The column conventions hold in CI: an undocumented exported column, or a timestamp without a time zone, fails the CI run.
- A league setup stored by any earlier build loads in the current one. Each new stored field costs a version and a migration step.
- Moving a quality threshold is one edit in `dbt_project.yml`, and the warn checks and the notebook move with it.
- A finding's history outlives its build: about 90 builds of history against seven builds kept.
- Retention is written down in one place, `docs/architecture.md`, and this record points to it.
