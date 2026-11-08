# 0030. Advanced stats in the projection, each judged walk-forward

Date: 2026-11-08
Status: Accepted

## Context

The audit behind #751 found the advanced stats unused. Usage rates, pace and the team-share lines had landed (`fct_player_game`, `fct_team_game`; every judged season has them for every game played), but no model read them. #771 asks for usage, efficiency, pace and role changes in a transparent shrinkage projection. Each feature enters only if it lowers walk-forward error, and its coefficient is published.

The owner also asked whether machine learning should be applied to the traditional and advanced stats. It was agreed that the transparent model is the production candidate. A gradient-boosted challenger runs through the same checkpoints as a reported benchmark. It ships only if it beats the transparent model by a margin declared in advance, and even then the owner decides, because transparency is a product value.

## Options considered

- **One model of every stat (the ML challenger alone).** It is opaque, and it is judged below: it loses out of sample.
- **Features judged one by one inside the projection's own arithmetic (chosen).** Each feature is a single coefficient with a neutral value, so the methodology page can say exactly what each number does.

## Decision

**Four features, each a coefficient per league** (`projection_features`, `mart_player_projection`). Each one's neutral value is the projection as it was.

| Feature | Coefficient | What it does |
| --- | --- | --- |
| pace | `pace` (off: 0) | Every per-minute counting rate is multiplied by (expected team pace / the pace of the games the rates were made in) ^ `pace`. Expected pace is the current team's pace this season, regressed toward last season's by `fantasy_matchup.prior_games` games. |
| usage | `usage_weight` (off: 1) | The current season's usage rate counts `usage_weight` times its production weight. The volume categories (points, threes, turnovers, shots, free throws) are scaled by that usage over the production-weighted usage. |
| efficiency | `fg_shrink`, `ft_shrink` (off: 0) | That many attempts at the league's percentage (reference season) are added to a player's weighted makes and attempts. |
| role | `other_team_production` (off: 1) | A past season spent mostly on another team keeps this share of its production weight. |

**The parts.** The projection is split into its parts (`int_player_projection_parts`: projected minutes, the games share and the weighted sums) and the mart that turns them into a line. `ops/projection_features.py` holds the mart's arithmetic in Python. Every walk-forward run exports the parts at every checkpoint (`ops.walk_forward --features-out`). The run fails unless Python reproduces the mart's line and the board's own value to 1e-9. A dbt unit test (`projection_features_adjust_the_rates`) pins the SQL, and `tests/test_projection_features.py` holds the Python to the same rows.

**The rule, posted on #771 before any run:**

- **Seasons.** Fit on NBA 2020-21 to 2022-23 and WNBA 2021 to 2023. Judge on NBA 2023-24 and 2024-25 and WNBA 2024 and 2025. The locked seasons are never read.
- **Measure.** The projection's own value per game (before the market prior), on the off build's scale, against what each player then did, over the players who then played 10+ games.
- **Order.** Forward selection on the pooled tuning RMSE.
- **Bar.** At each step the feature, at its best tuning grid point, enters only if all three hold on the judged checkpoints:
  - the pooled RMSE falls, with its 95% paired-bootstrap interval (1,000 resamples) below zero;
  - no checkpoint's RMSE rises by more than 0.010;
  - the pooled Spearman's interval is not wholly below zero.

**Runs.** The export runs:

- **NBA:** 42518215822 (2020-21), 42518217919 (2021-22), 42518220147 (2022-23), 42518222423 (2023-24), 42518225161 (2024-25).
- **WNBA:** 42518229324 (2021), 42518231473 (2022), 42518233507 (2023), 42518236169 (2024), 42518238385 (2025).

**Results.** Pooled over the 8 judged checkpoints, on minus off, with 95% intervals. The `ops.projection_features judge` output has every checkpoint (in the PR).

| League | Step | Feature at its tuning point | Pooled RMSE | Pooled Spearman | Verdict |
| --- | --- | --- | --- | --- | --- |
| NBA | 1 | usage, `usage_weight` 8 | 2.204 → 2.200, −0.0042 (−0.0074 to −0.0005) | +0.0006 (−0.0002 to +0.0013) | **enters** |
| NBA | 2 | efficiency, FG 50 / FT 25 | 2.200 → 2.184, −0.0161 (−0.0218 to −0.0103) | +0.0030 (+0.0017 to +0.0044) | **enters** |
| NBA | 3 | pace 1.0 | +0.0034 (+0.0005 to +0.0065) | −0.0004 (−0.0011 to +0.0004) | fails |
| NBA | 4 | role | no grid point lowered the tuning RMSE | | not judged |
| WNBA | 1 | usage, `usage_weight` 8 | +0.0004 (−0.0095 to +0.0107); +0.018 at 2024's tenth | −0.0015 (−0.0035 to +0.0004) | fails |
| WNBA | 2 | efficiency, FG 50 / FT 10 | 3.157 → 3.136, −0.0204 (−0.0413 to −0.0019) | +0.0014 (−0.0025 to +0.0055) | **enters** |
| WNBA | 3 | pace 1.5 | 3.136 → 3.126, −0.0097 (−0.0152 to −0.0046) | +0.0013 (−0.0009 to +0.0033) | **enters** |
| WNBA | 4 | role | no grid point lowered the tuning RMSE | | not judged |

**On per league where it passed:** NBA `usage_weight` 8, `fg_shrink` 50, `ft_shrink` 25; WNBA `pace` 1.5, `fg_shrink` 50, `ft_shrink` 10. Everything else stays neutral. Each coefficient is registered in `methodology/parameters.yml` with this evidence, and the Methodology page lists it.

**The board as built (confirmation runs).** `ops.walk_forward --features` builds each judged checkpoint with the league's features off, rebuilds the projection and what scores it with them on, and exports both builds with their own scales. `ops.projection_features confirm` then scores them two ways.

- **On the off build's scale (the declared measure).** dbt's on line reproduces the declared Python result to 1e-14 in value:
  - WNBA (runs 42528136868, 42528125201): pooled −0.0301 (−0.0504 to −0.0121). That is the same figure as efficiency and pace judged together.
  - NBA (runs 42529059871, 42529062473): pooled −0.0203 (−0.0275 to −0.0138), Spearman +0.0035 (+0.0022 to +0.0050). That is the same figure as usage and efficiency judged together.
- **Each build on its own scale.** The value scale's spreads come from the projected lines (ADR 0019). Shrinking shooting toward the league narrows them, so the on build measures a realized line in smaller units and every error looks larger:
  - **WNBA:** the shooting-impact spreads fall to 0.78–0.90 (FG) and 0.84–0.93 (FT) of the off build's. On that footing the pooled RMSE gap is +0.107 (+0.080 to +0.130) and Spearman −0.0045 (−0.0090 to −0.0002).
  - **NBA:** the shooting spreads fall to 0.87–0.94 of the off build's, and points widen to 1.03–1.05 with usage. Own value: RMSE +0.0071 (−0.0005 to +0.0142), Spearman +0.0014 (−0.0000 to +0.0030). The board with the market prior: RMSE +0.0157 (+0.0084 to +0.0225), Spearman +0.0009 (−0.0005 to +0.0023). Its ranking does not get worse.

  Two builds measured in different units are not comparable on RMSE. That is why the bar was declared on one scale. The own-scale figures are published here so that a reader sees both.

  **A small ranking cost on the WNBA board as users see it.** On its own scale the WNBA board ranks what players then did slightly worse with the features on: Spearman −0.0045 (−0.0090 to −0.0002).

  This is not only a matter of units. Narrower shooting spreads give FG% and FT% more weight in every realized line's value, so the realized order itself moves.

  The features still pass the declared bar, and they ship on it; the rule is not changed after seeing results. #915 asks whether the scale's spreads should come from lines a projection's features cannot shrink. It is to be judged on the next unspent season.

**ML challenger** (`ops/projection_challenger.py`, the `benchmark` dependency group; reported, not gated):

- **Model.** scikit-learn's HistGradientBoostingRegressor, one model per category.
- **Variants.** Raw inputs (seasons' rates, minutes, games, usage, pace, age, games share, absences), or those plus the transparent model's nine category scores (stacked).
- **Grid.** 48 points, chosen by leave-one-season-out cross-validation on the tuning seasons.
- **Margin.** To ship it had to beat the transparent model, with the entered features, by 3% of its pooled RMSE, with the interval below zero and no checkpoint worse by more than 0.010.

| League | Variant | Tuning CV RMSE | Judged pooled RMSE, challenger minus transparent | Spearman | Verdict |
| --- | --- | --- | --- | --- | --- |
| WNBA | raw | 3.553 | 3.126 → 3.487, +0.361 (+0.191 to +0.515) | −0.019 (−0.036 to −0.002) | does not ship |
| WNBA | stacked | 3.354 | +0.161 (+0.013 to +0.310) | −0.013 (−0.026 to +0.001) | does not ship |
| NBA | raw | 2.206 | 2.184 → 2.173, −0.011 (−0.048 to +0.029); 2024-25 worse at three checkpoints | +0.014 (+0.006 to +0.022) | does not ship |
| NBA | stacked | 2.123 | 2.184 → 2.072, −0.112 (−0.138 to −0.085), 5.1%; no checkpoint worse than +0.007 | +0.022 (+0.016 to +0.028) | **clears the margin; the owner decides** |

The NBA stacked challenger clears the declared margin. Most of its gain comes in 2023-24 and at a tenth of the way in: −0.33 then, against −0.10 at 2024-25's tenth and −0.01 to +0.01 at 2024-25's other checkpoints.

A diagnostic that was not declared, and so is reported only: a linear recalibration of the transparent value, fitted per checkpoint on the tuning seasons, gets −0.014 (−0.022 to −0.006) of that. So the challenger is adding ranking information, not just stretching a shrunk projection. It is not adopted. The production model stays transparent until the owner decides (#771's plan), and the follow-up is to find what it learns that a transparent term could carry (#916).

## Consequences

- **The projection uses the advanced lines.** In the NBA these are usage and the shooting shrinkage; in the WNBA, the shooting shrinkage and pace. Role change (production from another team's season) earned nothing in either league and is off.
- **Two coefficients sit at the edge of their grid:** NBA `usage_weight` 8 and WNBA `pace` 1.5. A wider grid would have to be fitted on the tuning seasons again and judged on seasons the fit has not seen. 2023-24 and 2024-25 (NBA) and 2024 and 2025 (WNBA) are now spent for the projection's features too.
- **The value scale's units move.** The shrinkage narrows the shooting spreads, so the windows' FG% and FT% values, which are measured on the projection's scale (ADR 0019), read wider than before. The Methodology page's numbers for the projection come from this record.
- **The challenger stays a benchmark for now.**
  - In the WNBA it loses out of sample in both variants.
  - In the NBA the stacked variant clears the declared margin. Adopting it would trade the projection's transparency for about 5% of RMSE, and that is the owner's decision.
  - The harness keeps it runnable, so it can be re-judged when more seasons land.
- **A new projection input** must be added to `int_player_projection_parts`, to the mart and to `ops/projection_features.lines`. The harness's parity check fails a run where they disagree.
