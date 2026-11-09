# 0031. Board value, validated in season; preseason value badged until judged

Date: 2026-11-09
Status: Accepted (by the owner on 2026-11-09, #936 rule 2)

## Context

Every page leans on the board's value: Rankings and the Player page show it, and My Team, Pickups and Trade build on it. #754 judged it walk-forward (ADR 0018, `ops.walk_forward`) on NBA 2020-21 to 2024-25 and WNBA 2024 and 2025. Each season was cut at four checkpoints: the first game day, a tenth, a quarter and half way (`backtest.checkpoints`). The baseline is the naive manager: the season so far per game, and last season's line before a player has played. Both are scored on each checkpoint's own value scale (ADR 0019) against what each player then did, over the players who then played 10 or more games (`backtest.min_games`). Intervals are 95% paired bootstraps of the gap over players (`backtest.bootstrap`, 1,000 resamples).

**The bar #751 declared before the runs** was fuller than what was met. Out of sample, each feature beats the naive manager **and** ESPN's market rank, on its projection error **and** on a decision replay of its advice. #754's second comment checked the results against it. Projection error against the naive manager passed in season. Ranking and the market were not confirmed at each in-season checkpoint. No decision replay of the value itself was run. So the issue stayed open, and My Team hid the value (#926).

**The owner's decision (#936, rule 2):** the board's value counts as validated in season on its projection error against the naive manager. Preseason value carries a badge each year until it is judged. This bar was accepted after the results, not declared before them. That is weaker than the other features' bars, and this record says so.

## The evidence

**RMSE of value per game, board minus naive manager** (#754, first comment). Negative means the board erred less. Every interval lies wholly below zero except the two shown.

| Season | First game day | A tenth | A quarter | Half way |
| --- | --- | --- | --- | --- |
| NBA 2020-21 | −0.143 | −0.921 | −0.468 | −0.211 |
| NBA 2021-22 | −0.094 | −0.789 | −0.440 | −0.370 |
| NBA 2022-23 | −0.110 | −0.848 | −0.343 | −0.170 |
| NBA 2023-24 | −0.041 (−0.168 to +0.099) | −0.785 | −0.478 | −0.187 |
| NBA 2024-25 | −0.130 | −0.958 | −0.620 | −0.284 |
| WNBA 2024 | −0.280 | −1.254 | −0.509 | −0.597 |
| WNBA 2025 | −0.277 | −1.484 | −0.678 | −0.278 (−0.691 to +0.050) |

**The counts:**

- **All checkpoints:** 28 (7 seasons × 4). The board is lower at all 28, and the interval is clear of zero at 26.
- **In season** (a tenth, a quarter, half way): 21 checkpoints, 15 NBA and 6 WNBA. The board is lower at all 21, clear at 20. The exception is WNBA 2025 half way.
  - #754's second comment counted "12 in-season" NBA checkpoints. Five seasons give 15, and all 15 are clear.
- **The first game day** (preseason value): 7 checkpoints. The board is lower at all 7, clear at 6. The exception is NBA 2023-24.

**Out of sample in time; not every setting was chosen elsewhere.** Each checkpoint's board reads only what was known before it (ADR 0018). The projection's weights, however, were chosen in ADR 0009 on replays of NBA 2023-24 to 2025-26 and WNBA 2021 to 2026, before the harness existed. NBA 2020-21, 2021-22 and 2022-23 were in none of those replays (the data then held no earlier NBA season). On their 9 in-season checkpoints the board is lower with every interval below zero. The other 12 in-season checkpoints are out of sample in time only.

**Ranking (Spearman), against the naive manager.** Per-checkpoint figures were posted for two seasons only (#769):

- **NBA 2024-25:** in season 0.827 to 0.838 against 0.795 to 0.812; first game day 0.840 against 0.844.
- **NBA 2023-24:** a tenth 0.762 against 0.723; a quarter 0.790 against 0.782; half way **0.807 against 0.812**; first game day 0.787 against 0.800.
- **The other seasons:** "usually ahead" in season, with no figures. Preseason, level within about ±0.01.

**Against the market** (ESPN's preseason draft order; the WNBA has no past market, ADR 0020):

- **Its top pool:** preseason, the market holds as much of the realized top pool as the board, or more, in 4 of the 5 NBA seasons: 87% against 79% in 2020-21, 79% against 78% in 2021-22 and 85% against 81% in 2024-25.
- **Its whole order** ranks worse: Spearman 0.70 to 0.83 against the board's 0.78 to 0.84, falling below the board as the season goes. No in-season figure per checkpoint was posted.

**The board as built since.** These runs came before the market prior (ADR 0020) and the advanced stats (ADR 0030). Each was fitted on NBA 2020-21 to 2022-23 (and WNBA 2021 to 2023) and entered only after lowering the board's own walk-forward error on NBA 2023-24 and 2024-25 (and WNBA 2024 and 2025):

- **The prior** lowered it at a tenth and a quarter in, and was level by half way.
- **Usage and the shooting shrinks** in the NBA, and the shrinks and pace in the WNBA, lowered it pooled over the checkpoints. Their rule let no checkpoint rise by more than 0.010.

So the board as built errs no more in season than the board #754 judged, within those limits. One caveat: the WNBA shrinks cost Spearman, −0.0056 (−0.0096 to −0.0014), which #915 re-judges.

## Options considered

- **Hold the board to #751's full bar** (error and ranking against the naive manager and the market, and a decision replay) before it counts. No part of that bar was confirmed in season except the error against the naive manager. Every page would keep a badge on the number it is built on.
- **Validate it in season on its error against the naive manager, and badge preseason value (chosen).** This is the one test it clearly passes, on every in-season checkpoint but one, and on all 9 that no setting was chosen on.
- **Validate it everywhere.** Before the season its ranking is no better than last season's line, and the market's top tier is better. Rejected.

## Decision

**Board value per game is validated in season.** It is shown without a badge from a tenth of the season in. In the NBA, the badge stays until the market prior has faded.

- **The bar it met:** at a tenth, a quarter and half way through a season, its RMSE against what players then did is below the naive manager's, with the interval clear of zero. That held at 20 of 21 in-season checkpoints, in both leagues, and at all 9 in-season checkpoints of the seasons no setting was chosen on.
- **Arithmetic on it counts as validated with it:**
  - re-scoring to a league's own teams, roster spots and punts (`web/src/lib/league-value.ts`), which moves only the replacement level and drops punted columns;
  - tiers, which are natural breaks on the ranking (ADR 0009).
- **Not covered by this record.** #754 judged value per game.
  - **The season and rest-of-season totals** multiply it by the expected share of games played (`projection.durability_games`, `projection.typical_share`; ADR 0009, in sample). #754 did not judge that share, so it stays open there.
  - **The weekly projection** reads a different test: the matchup card's chances (ADR 0026).

**Preseason value carries a badge, every season, until it is judged.** It covers three windows:

- before a season's first game;
- after its regular season ends, when the board projects the next one;
- in season, until the later of two points:
  - a tenth of the season's games, the first in-season checkpoint judged;
  - in a league the market prior is on, its fade (`projection.market_prior.fade_games`, 20 NBA team games), while preseason information still weighs in the value.

`valuePhase` (`web/src/lib/value-phase.ts`) decides the badge from the board's rows: the games played, the games left and whether the season is over. It reads both numbers from the registry. It is not yet wired into the pages. Until it is, the Board's "not yet validated" note on value stays, which errs toward caution (#936).

**What did not pass**, and stays open on #754:

- **Preseason ranking.** It is level with the naive manager, and the market's top pool is better in 4 of 5 NBA seasons.
- **In-season ranking.** It was not confirmed at each checkpoint, and naive was ahead at NBA 2023-24 half way.
- **Against the market in season:** not measured per checkpoint.
- **A decision replay of the value's own advice.** ADRs 0021, 0024 and 0027 replay decisions built on the value, not the value itself.

## Consequences

- **The registry:** the entries #754 judges cite this record in their evidence. None changes how it was set (`status`); `projection.typical_share` stays assumed. The verdict belongs to the feature, so it lives with the Methodology page's feature list, not with each number.
- **The pages:** value per game shows without a badge in season. Preseason value is badged by `valuePhase`.
- **Next judgements:**
  - **In season:** NBA 2026-27's checkpoints after its regular season (April 2027), and WNBA 2027's (September 2027), on the same measure. A fail at more than one in-season checkpoint of a league puts the badge back in that league. The locked seasons (NBA 2025-26, WNBA 2026, #769) get their one judgement as planned. ADR 0009's replays read them, so for the projection's own weights they are out of sample in time only.
  - **Preseason:** NBA 2026-27's first game day (20 October 2026), judged once its regular season ends, against the naive manager and ESPN's 2026-27 draft order. The bar is to be declared on #754 before that run. The market prior's fit cannot be re-tuned on 2023-24 or 2024-25, which are spent for it (ADR 0020).
