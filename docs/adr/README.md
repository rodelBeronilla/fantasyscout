# Architecture decision records

One record per real decision, written when the decision is made. Numbered; a later record supersedes an earlier one, and the table says which.
| ADR | Title | Date | Status | Supersedes | Superseded by |
| --- | --- | --- | --- | --- | --- |
| [0001](0001-hosting-path.md) | Host FantasyScout on its own subdomain | 2026-10-26 | Accepted |  |  |
| [0002](0002-where-ingestion-runs.md) | Where ingestion runs | 2026-10-27 | Accepted (option A, decided by the owner on 2026-10-27) |  |  |
| [0003](0003-gold-modelling.md) | Gold modelling choices | 2026-10-27 | Accepted |  | 0009 to 0012 for the sections moved there (pointers in the record); 0019 for the pool rule |
| [0004](0004-stats-api-request-economy.md) | Stats API request economy | 2026-10-27 | Accepted |  |  |
| [0005](0005-reconciliation.md) | Reconciling the two sources | 2026-10-27 | Accepted |  |  |
| [0006](0006-serving-layout.md) | How gold reaches the site | 2026-10-27 | Accepted |  |  |
| [0007](0007-yahoo-league-import.md) | Importing a Yahoo Fantasy league | 2026-10-29 | Accepted |  |  |
| [0008](0008-stats-terms-and-private-tables.md) | The statistics' terms, source credit and the private tables | 2026-10-29 | Accepted |  |  |
| [0009](0009-board-value.md) | Board value | 2026-10-29 | Accepted | none: moved from ADR 0003 on 2026-11-01, text unchanged |  |
| [0010](0010-availability-calibration.md) | Availability calibration | 2026-10-30 | Accepted | none: moved from ADR 0003 on 2026-11-01, text unchanged |  |
| [0011](0011-streamers-sort.md) | Streamers sort | 2026-10-30 | Accepted | none: moved from ADR 0003 on 2026-11-01, text unchanged |  |
| [0012](0012-signals-tested-and-not-built.md) | Signals tested and not built | 2026-10-30 | Accepted | none: moved from ADR 0003 on 2026-11-01, text unchanged |  |
| [0013](0013-where-the-dbt-build-runs.md) | Where the dbt build runs | 2026-11-02 | Accepted | the orchestration row of SPEC.md and docs/architecture.md |  |
| [0014](0014-conventions-and-retention.md) | Platform conventions and retention | 2026-11-02 | Accepted |  |  |
| [0015](0015-categories-standings-model.md) | A standings model for categories leagues | 2026-11-03 | Accepted |  | 0021 for the spreads |
| [0016](0016-accounts-for-league-setups.md) | Accounts for league setups | 2026-11-03 | Accepted |  |  |
| [0017](0017-local-language-model.md) | A local language model for phase 7 | 2026-11-03 | Accepted |  |  |
| [0018](0018-point-in-time-builds.md) | Point-in-time builds | 2026-11-07 | Accepted |  |  |
| [0019](0019-one-value-scale.md) | One value scale | 2026-11-07 | Accepted | 0003's pool rule |  |
| [0020](0020-preseason-market-prior.md) | A preseason prior from the market's draft order | 2026-11-08 | Accepted |  |  |
| [0021](0021-standings-model-validated.md) | The standings model, judged on simulated leagues | 2026-11-08 | Accepted | 0015's spreads |  |
| [0022](0022-trade-page-judged.md) | The Trade page, judged on simulated leagues | 2026-11-08 | Accepted |  |  |
## Addenda
A record is not edited after acceptance, but it may grow **addenda**: dated sections that add evidence, record a measurement, or note what happened when the decision met real data. An addendum may not change the decision; a changed decision is a new record that says what it supersedes, and the old record gets a one-line pointer where the superseded text stands (in italics, so the original reads as written). When a record's addenda become a subject of their own, they move to a new record with the text unchanged and a pointer left behind; the new record's header says `Moved from:` instead of `Supersedes:`, because a move changes no decision. ADR 0003 did this on 2026-11-01 (0009 to 0012).
Template:
```markdown
# NNNN. Title
Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by NNNN
Supersedes: NNNN (when it does)
## Context
## Options considered
## Decision
## Consequences
```
