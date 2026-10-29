# Architecture decision records

One record per real decision, written when the decision is made. Numbered, never edited after acceptance; a later ADR supersedes an earlier one.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-hosting-path.md) | Host FantasyScout on its own subdomain | Accepted |
| [0002](0002-where-ingestion-runs.md) | Where ingestion runs | Accepted (self-hosted runner for the stats API) |
| [0003](0003-gold-modelling.md) | Gold modelling choices | Accepted |
| [0004](0004-stats-api-request-economy.md) | Stats API request economy | Accepted |
| [0005](0005-reconciliation.md) | Reconciling the two sources | Accepted |
| [0006](0006-serving-layout.md) | How gold reaches the site | Accepted |
| [0007](0007-yahoo-league-import.md) | Importing a Yahoo Fantasy league | Accepted |
| [0008](0008-stats-terms-and-private-tables.md) | The statistics' terms, source credit and the private tables | Accepted |

Template:

```markdown
# NNNN. Title

Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by NNNN

## Context
## Options considered
## Decision
## Consequences
```
