# 0028. A lasting share per tally for the playoff odds, tried and rejected

Date: 2026-11-08
Status: Accepted

## Context

#872 (ADR 0025) judged the playoff odds on simulated leagues with one lasting share, `playoffs.season_share` (NBA 0.3, WNBA 0.2), for both tallies.

- **The baselines:** the odds beat the coin and the naive manager everywhere.
- **Calibration:** it failed. The matchups tally was too timid in three of four judged seasons, and the categories tally too sure in WNBA 2025.

#900 asked for one share per tally, each fitted alone.

Two kinds of season were ruled out:

- **The seasons #872 judged** (NBA 2023-24 and 2024-25, WNBA 2024 and 2025) are spent for this parameter, since their failure shaped the rework.
- **The locked seasons** (NBA 2025-26, WNBA 2026) stay reserved for the epic's final hold-out (#751).

## Options considered

- **Judge once on the locked seasons.** This would spend the final hold-out on one parameter.
- **Re-judge on the spent seasons.** This is in-sample in all but name.
- **Leave one tuning season out (chosen),** as ADR 0022 did.
  - The evidence is cross-validated within the six tuning seasons, not judged on seasons no fit has seen.
  - The pass bar was declared on #900 before any run.

## Decision

**The harness** is `ops.playoff_cv`, run locally on the #755 runs' inputs (42466140329, 42468833908, 42466144841, 42468836211, 42466314090, 42466316345). It has six folds, one per tuning season.

- **The fit:** each fold fits on the other two seasons of its league.
  - First `standings.spread_scale`, by #755's rule. It came out 2.0 in every fold.
  - Then each tally's share alone, on #872's grid (0 to 0.8), by the lowest log loss of that tally's odds.
- **Not refitted:** `standings.game_spread`, an ad hoc measurement (ADR 0015).
- **The judgement:** the held-out season, judged by #872's bar: the leagues, odds, outcomes, baselines and resamples of `ops.playoff_backtest`.
  - The harness's checkpoint now takes a share per tally and a spread scale.
- **The pass rule:** at least 5 of 6 folds, and the six pooled.

**The result: rejected.** 0 of 6 folds pass, and the pooled figures pass.

- **The split goes the way #872 guessed.** The matchups tally wants less of a lasting share in every fold: 0 to 0.2, against 0.2 to 0.5 for categories.
- **Single seasons swing both ways.** At the first game day the slope runs from 0.33 (WNBA 2022) to 1.69 (NBA 2022-23):
  - NBA 2020-21, WNBA 2021 and WNBA 2022 are too sure in places;
  - NBA 2021-22, NBA 2022-23 and WNBA 2023 are too timid in places.
  - The coin is not beaten at the first game day in three folds.
- **Pooled, every condition holds:**
  - the slope is 0.90 to 1.02 at every checkpoint, in both tallies;
  - the odds beat the coin by +0.009 to +0.104;
  - in season they beat the naive manager by +0.051 to +0.137;
  - every interval is clear of zero.
- **No better than one share held out:** the mean held-out log loss is
  - categories: 0.5786 per tally, against 0.5784 with one share;
  - matchups: 0.5737 per tally, against 0.5749.
  - By the bar the one share stays.

**Why:** each season's 200 simulated leagues share one season of games. A single season's slope is closer to one draw of which players beat their projections than to 200 independent ones. A lasting share moves every season's slope the same way, so no value of it, per tally or not, can bring seasons that miss in opposite directions together.

**What changes:** nothing on the site but the badge's link.

- `playoffs.season_share` keeps its form and values (NBA 0.3, WNBA 0.2).
- The Playoffs tile keeps its "not yet validated" badge in category leagues, now linked to #907.

## Consequences

- **The tuning seasons are now spent for the odds' lasting share too.** Every season that can be built has now been read for it, except the locked ones.
- **#907 (the owner's call)** sets out the options:
  - judge calibration pooled over seasons, once, on the locked seasons (recommended);
  - show no odds at the first game day;
  - remove the odds (not recommended).
- **A season-by-season calibration bar may be out of reach for any season-level forecast** judged on simulated leagues that share their season's games. Later bars for season-long figures should say whether they pool.
