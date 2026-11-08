# 0022. A rotisserie projection spread by the games left, tried and rejected

Date: 2026-11-08
Status: Accepted

## Context

#755 (ADR 0021) judged the rotisserie category win chances.

- **In season** they are calibrated.
- **At the first game day** they are too timid: calibration slope 1.79 to 2.42 in the four judged seasons.

The model has one projection spread for every horizon (`standings.projection_spread`, 0.8). #866 asked for a spread that depends on the games left, refitted on the tuning seasons and judged on seasons that fit has not seen.

Two kinds of season were ruled out:

- **The seasons #755 judged** (NBA 2023-24 and 2024-25, WNBA 2024 and 2025) are spent for this parameter: their failure shaped the rework.
- **The locked seasons** (NBA 2025-26, WNBA 2026) stay reserved for the epic's final hold-out (#751).

No other season can be built: the NBA landing starts at 2018-19, and a walk-forward season needs two seasons before it.

## Options considered

- **Judge once on the locked seasons.** This would spend the epic's final hold-out on one parameter.
- **Re-judge on the spent seasons.** This is in-sample in all but name.
- **Leave one tuning season out (chosen).** The evidence is cross-validated within the six tuning seasons, every parameter refitted in every fold.

## Decision

**The rework:** a projection's error in two parts, p(g)² = a² + b² ÷ g, with g the games left.

- a is the part that lasts however many games are left.
- b is the part that averages out over them.
- At b = 0 it is today's model.

**The judgement,** `ops.roto_backtest cv`, as declared on #866 before any run:

- **Six folds,** one per tuning season (NBA 2020-21 to 2022-23, WNBA 2021 to 2023). The parameters are per league, so each fold fits on the other two seasons of its league.
- **Everything refitted in every fold,** on that fold's training seasons only: `standings.spread_scale` by #755's rule, then (a, b) by the lowest rotisserie log loss. The held-out season is clean for every parameter.
- **The inputs:** the leagues, drafts and checkpoints of #755's runs (42466140329, 42468833908, 42466144841, 42468836211, 42466314090, 42466316345).
- **The baseline,** Constant: b = 0, refitted in the same fold. This gives a paired comparison.
- **The gating number:** the calibration slope at the first game day, 0.8 to 1.25. The rework had to pass in 5 of 6 folds and pooled.

**The result: it fails.**

- The fit chose **b = 0 in all six folds**, so the rework is Constant in every fold (Brier gap to Constant 0.0000).
- The slope at the first game day:
  - NBA: 1.32, 1.29 and 2.20;
  - WNBA: 1.68, 1.56 and 1.63;
  - pooled: 1.52 (1.47 to 1.57).
- 0 of 6 folds pass.
- In season the pooled slopes are 0.91, 0.98 and 1.05.

**Why the form cannot work.** Between the first game day and a tenth of the way in, the games left barely move (82 to about 74 in the NBA), but the slope falls from 1.3 to 2.2 to about 1. The miss is not the horizon. It is what the board knows before the season's first game: last season and the market prior (ADR 0020).

**What ships:**

- **The web is unchanged.** The constant spread stays, and nothing is added to the registry.
- **The harness stays.** `ops.standings.spreads` keeps a `projection_games` argument (default none) so the judgement can be re-run.
- **The badge:** rotisserie leagues keep the "not yet validated" badge on Your categories, now linked to the next rework (#898).

## Consequences

- **#898 lays out two options for the owner:**
  - a preseason projection spread, judged by the same folds;
  - no rotisserie chances until the season's first games are in. Removing that is the owner's call.
- **The leave-one-season-out design is the template** for any parameter whose judged seasons are spent: refit everything in each fold, declare the fold rule before any run, and keep the locked seasons out.
- **A side finding:** at the first game day the WNBA rotisserie chances do not beat the naive manager in 2021 and 2022 (Brier −0.0035 and −0.0017, intervals below zero), as #755 found in WNBA 2025. Pooled over the six seasons the gap is +0.0001 (−0.0002 to +0.0005).
