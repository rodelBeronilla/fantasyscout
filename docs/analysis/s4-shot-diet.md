# S4: shot diet before shooting luck

Issue #1082, step 4. The yardstick and the bar are S0's (#1077); the result is recorded in ADR 0012 and `methodology/features.yml` (`shot-diet`). **It failed, in both leagues.** Reproduce with:

```
uv run python -m ops.shot_diet fit --shots shot-diet-nba/ closeness-nba-2020-21/ ... --out fit.json
uv run python -m ops.shot_diet judge --shots shot-diet-nba-judged/ shot-diet-wnba-judged/ \
    --tuning closeness-nba-2020-21/ ... --judged closeness-nba-2023-24/ ... --out s4.json
```

## The basketball idea

A player who has made 9 of his last 15 threes looks hot. Mostly that is luck: a shooter's percentage needs hundreds of attempts to settle. What settles quickly is **where he shoots from**: at the rim, in the paint, from mid-range, from the corners, from above the break. That is his role and his habit.

So the study asked: forget his recent hit rate. Take his **recent shot diet**, the share of his attempts from each zone over his last games. Multiply it by **how well he has shot from each zone over years**, pulled toward the league's accuracy from that zone when his own sample is small. Does that predict next week's FG% and threes better than the projection does now?

## What was measured

- **Who.** S0's players. Each Monday, the top 130 on the board among the players with a game that week: an eight-team league's 104 rostered players and the next 26 on waivers.
- **What.** Each player's real week, against two forecasts made that Monday:
  - **the projection-week:** today's projection per game times his team's games, none if he is listed out or doubtful;
  - **the study's week:** the same, with FG% and threes replaced by the shot diet.
- **How FG% is scored.** The forecast percentage at the attempts he really took, so the error is in made shots. A volume shooter counts for more, as he does in a head-to-head matchup.
- **FG% from the diet.** His share of attempts from each zone over his last 20 games, times his accuracy from that zone. The accuracy covers this season so far and the two before, with 100 attempts at the league's rate from the zone added in.
- **Threes from the diet.** The projection's attempts per game, times his share from the three-point zones, times his shrunk accuracy from them.
- **Nothing from the future.** Every input comes from shots in games before the Monday. Each run proves it on every Monday: deleting, or rewriting, every later shot changes no input.
- **The settings,** chosen on the tuning seasons only (NBA 2020-21 to 2022-23, WNBA 2021 to 2023), then frozen in commit b74a3a4 before any judged season was read:
  - zones: two (twos and threes), three (rim, other twos, threes) or five (rim, paint, mid-range, corner three, above the break);
  - the attempts added from the league: 25, 50, 100, 200 or 400;
  - the recent window: the last 10 or 20 games.
- **The test.** Judged once on NBA 2023-24 and 2024-25 and WNBA 2024 and 2025. The locked seasons were not touched.
- **The bar (S0's).** In both FG% and threes, the study's error (RMSE) must fall by at least a quarter of S0's noise, with the 95% interval of the change below zero.

## What the data said

**On the tuning seasons**, where the settings were chosen:

- **FG%:** the diet helped a little in both leagues.
  - NBA: 2.949 → 2.933 makes of error a week, with two zones, 100 attempts and 20 games.
  - WNBA: 1.835 → 1.816, at the same point.
- **Threes:**
  - NBA: barely helped, 3.754 → 3.750, and only at the most cautious setting (400 attempts from the league, five zones).
  - WNBA: worse at every one of the 30 settings, 1.733 → 1.808 at the best of them.

**On the judged seasons**, the one test that counts:

- **FG%:**
  - NBA: it moved the right way, −0.016, but by too little to tell from noise.
  - WNBA: it cleared its bar, −0.027.
- **Threes:** worse in both leagues. In the WNBA the interval sits wholly above zero.

Why the threes fail: a player's three-point volume follows his role, which the projection already carries through his minutes and usage. His recent share of threes is about as noisy as his recent hit rate. Accuracy from a zone does settle, which is why FG% gained a little, but the projection already shrinks each player's FG% toward the league's (ADR 0030). The diet adds only the part that a center's FG% is not a guard's.

## The numbers that decide it

Study minus projection, in the week's error (RMSE: made shots for FG%, threes for 3PM), with the 95% paired bootstrap interval. The bar is a quarter of S0's noise.

| League | Category | Projection | Study | Study − projection (95%) | Bar | Passes |
| --- | --- | --- | --- | --- | --- | --- |
| NBA | FG% | 2.885 | 2.870 | −0.016 (−0.041 to +0.010) | ≤ −0.011, interval below 0 | no |
| NBA | 3PM | 3.710 | 3.719 | +0.009 (−0.015 to +0.033) | ≤ −0.016, interval below 0 | no |
| WNBA | FG% | 1.938 | 1.911 | −0.027 (−0.046 to −0.007) | ≤ −0.010, interval below 0 | yes |
| WNBA | 3PM | 1.964 | 1.985 | +0.021 (+0.000 to +0.041) | ≤ −0.012, interval below 0 | no |

- **Population:** NBA 50 weeks and 6,240 player-weeks; WNBA 37 weeks and 4,160.
- **The other seven categories** are the projection's, unchanged, so none gets worse.
- **Seed check** (seeds 0 to 19): WNBA FG%'s upper bound stays below zero in 20 of 20 seeds (−0.0092 to −0.0072). NBA FG%'s stays above zero in all 20 (+0.007 to +0.012).
- **Shots cover every judged game:**
  - the shots' attempts match the box scores' to within two a season;
  - 98.5% to 100% of the population's player-weeks had shots before the Monday;
  - the rest kept the projection's line.
- **Verdict: fail in both leagues.** The bar asks for both target categories; threes failed in both, and NBA FG% fell short. Per the rule, the recipe is not retried with a tweak.

## What it means for your team

Nothing on the site changes. Your FG% and threes forecasts stay the projection's.

The practical lesson is the one the basketball idea started from, only weaker than hoped. Don't chase a hot shooting fortnight, and don't panic over a cold one. The projection already discounts both, and knowing where a player shoots from adds almost nothing to that over a single week. A week of FG% is decided mostly by which shots fall. For threes, trust volume, which comes from minutes and role, over a recent run of hits.

The WNBA FG% result passed on its own, about 1.4% less error. That is not enough to ship a call: the bar needed both categories, and the judged seasons have already been used by every earlier study. A shot-zone FG% for the WNBA alone would need a new study with its own bar, written first and confirmed on weeks not yet played.

## Runs

| What | Runs |
| --- | --- |
| S0's tuning exports (the yardstick, the bar's noise) | 44942094895, 44942100340, 44942105040 (NBA 2020-21 to 2022-23); 44942110202, 44942115669, 44942120406 (WNBA 2021 to 2023) |
| Tuning shots (fit only) | 44943358268 (NBA 2018-19 to 2022-23), 44949158118 (WNBA 2019 to 2023) |
| Judged exports, the same export code (from #1079's runs) | 44952405832 (NBA 2023-24), 44954196831 (NBA 2024-25), 44956085033 (WNBA 2024), 44958765100 (WNBA 2025) |
| Judged shots, on the frozen commit | 44956581445 (NBA 2021-22 to 2024-25), 44959320947 (WNBA 2022 to 2025) |

The S0 noise reproduced here matches #1077's recorded table to the fourth decimal in every category.
