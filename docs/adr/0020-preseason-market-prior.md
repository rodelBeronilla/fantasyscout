# 0020. A preseason prior from the market's draft order

Date: 2026-11-08
Status: Accepted

## Context

The walk-forward harness (ADR 0018, #797) judged the board out of sample in NBA 2020-21 to 2024-25 (#754).

- **In season** it beats a naive manager at every checkpoint.
- **Preseason** its ranking is no better than last season's line.
- **ESPN's preseason draft order** holds as much of the realized top pool as the board, or more, in four of the five seasons. In 2020-21 it held 87% against the board's 79%. It ranks the rest worse.

So the market knows something about the top tier before the season that the board does not, and it goes stale as games are played.

## Options considered

- **Leave the board as it is.** The market's edge is preseason only, where the board is weakest.
- **Rank by the draft order before the season.** This loses the board's better order below the top tier, and the market has no values.
- **Blend the two, fading the market with games played.** The market's rank is priced on the board's own scale: the board's value of the player at that rank, as Trade's `marketValues` does in the web. That puts both in the same units, so a blend is a value, not a rank.

## Decision

**The board blends toward the market while a player has few games** (`mart_board`, `int_market_prior`, var `market_prior`):

    value = own + w * (market - own)
    w     = weight * max(0, 1 - games / fade_games)

- **own:** the sum of the nine categories.
- **market:** the board's own value at the player's ESPN draft rank.
- **games:** his regular-season games in the season being played.
- **No blend** for an undrafted player, a rank beyond the board, or the time between seasons. Those keep their own value.
- **What moves:** `z_total`, `value_per_game`, `value_total`, `rank_total` and `in_pool`. The nine category columns stay the projection's, so punt builds keep the projection's profile.

**Fitted on the tuning seasons only.** The rule was declared on #832 before any run:

- **Fit seasons:** NBA 2020-21, 2021-22 and 2022-23 (runs 42456036003, 42456038211 and 42456040262).
- **Selection:** the highest mean Spearman over the first-game-day and tenth checkpoints, among the grid points whose RMSE is no worse at any of the six. Ties go to the smaller weight, then the faster fade.
- **Grid:** weight 0 to 1 in steps of 0.05; fade_games 1, 2, 3, 5, 8, 12 or 20.
- **Pick:** weight 0.45 and fade_games 20 (`ops.market_prior_fit`), which raised the mean Spearman from 0.791 to 0.816.

**Judged out of sample** on NBA 2023-24 (run 42458451893) and 2024-25 (run 42458454350). Each run built every checkpoint once, then rebuilt `mart_board` from the same cut with the prior on and checked that the SQL matches `walk_forward.blend`. The figures are on minus off, over the players who then played 10+ games, with 95% paired bootstrap intervals (1,000 resamples):

| Checkpoint | RMSE | Spearman | Top-pool share | Players moved |
| --- | --- | --- | --- | --- |
| 2023-24 first game day | 2.179 → 2.014, −0.165 (−0.242 to −0.089) | 0.787 → 0.816, +0.029 (+0.011 to +0.048) | 78.8% → 83.3%, +4.5 (+0.6 to +7.7) | 341 of 419 |
| 2023-24 a tenth in | −0.075 (−0.126 to −0.024) | +0.025 (+0.014 to +0.038) | +2.6 (0.0 to +6.4) | 369 of 467 |
| 2023-24 a quarter in | −0.048 (−0.080 to −0.018) | +0.008 (+0.002 to +0.015) | +0.6 (−0.6 to +3.2) | 306 of 460 |
| 2023-24 half way | −0.008 (−0.024 to +0.008) | −0.000 (−0.004 to +0.004) | 0.0 (0.0 to +1.9) | 64 of 437 |
| 2024-25 first game day | 2.056 → 1.838, −0.218 (−0.308 to −0.131) | 0.840 → 0.867, +0.028 (+0.014 to +0.043) | 81.4% → 85.3%, +3.8 (0.0 to +7.1) | 344 of 423 |
| 2024-25 a tenth in | −0.084 (−0.145 to −0.023) | +0.015 (+0.005 to +0.025) | +0.6 (−1.3 to +3.8) | 386 of 486 |
| 2024-25 a quarter in | −0.061 (−0.102 to −0.020) | +0.005 (−0.003 to +0.012) | 0.0 (−1.9 to +2.6) | 245 of 472 |
| 2024-25 half way | −0.018 (−0.040 to +0.006) | +0.001 (−0.004 to +0.005) | −0.6 (−1.3 to +1.3) | 73 of 448 |

**The bar is cleared.** On both judged seasons, at the first game day:

- Spearman rises, with intervals clear of zero.
- RMSE falls, with intervals below zero.
- Top-pool share rises: +4.5 points (+0.6 to +7.7) and +3.8 (0.0 to +7.1). In 2024-25 the lower bound touches zero.

At a tenth and a quarter in, the prior still helps or is level. By half way it moves only the players with under 20 games, and changes nothing measurable: every interval spans zero.

**On for the NBA only** (`market_prior.leagues: [nba]`). ESPN serves no past WNBA draft order (#805), so the WNBA prior has never been tested, and the methodology (#751) does not adopt an untested number.

## Consequences

- **The harness judges the board as built.** `ops.walk_forward` without `--market-prior` now judges the NBA board with the prior on. `--market-prior` judges it off and on, and `--players-out` writes the figures the fit reads. The fit refuses any season outside the tuning three.
- **The quality check measures replacement level on the projection's own value** (`assert_one_value_scale`), since the prior moves `z_total`, not the scale.
- **The fade sits at the edge of the grid** (20 games, the slowest tried). A slower fade may fit better. Re-fitting on a wider grid has to use the tuning seasons again and be judged on seasons the fit has not seen. 2023-24 and 2024-25 are spent for this parameter.
- **The live board needs the season's draft order.** `int_market_prior` reads `silver.espn_preseason_adp`, which holds only the seasons a history run has landed. Until the season being played is landed there, the prior does nothing in production (#847).
- **The web's league-scaled values do not see the prior yet.** They are rebuilt from the categories: the Board for a reader's own league, My Team and Trade. The Player page's value per game does carry it (#848).
