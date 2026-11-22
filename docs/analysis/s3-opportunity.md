# S3: opportunity before outcome

Issue #1081, step 4. The yardstick and the bar are S0's (#1077); the result is recorded in ADR 0012 and `methodology/features.yml` (`opportunity-chances`). **It failed, in all four target categories.** NBA only: player tracking exists only for the NBA, so the WNBA was not run. Reproduce with:

```
uv run python -m ops.s3_opportunity fit closeness-nba-2020-21/ ... --chances s3-chances-tuning/ --out fit.json
uv run python -m ops.s3_opportunity judge --chances s3-chances-judged/ \
    --tuning closeness-nba-2020-21/ ... --judged closeness-nba-2023-24/ closeness-nba-2024-25/ --out s3.json
```

## The basketball idea

Rebounds, assists, steals and blocks bounce around from week to week. A big man pulls down 9 a night for two weeks, then 14. A guard's assists depend on whether his teammates hit the open shot he gave them.

The NBA's player tracking counts the chances behind each of these:

- **rebound chances:** rebounds he was within 3.5 feet of;
- **potential assists:** passes to a teammate who shot within one dribble, made or missed;
- **deflections:** passes and dribbles he got a hand to;
- **contested shots:** opponents' shots he contested.

The idea: the chances reflect his role and his effort, and settle within a few games. Whether a chance turns into a rebound, an assist, a steal or a block depends more on teammates and luck. So take his **recent chances** and multiply them by **his long-run rate of turning chances into the stat**. Does that predict next week's REB, AST, STL and BLK better than the projection does now?

## What was measured

- **Who.** S0's players. Each Monday, the top 130 on the board among the players with a game that week: an eight-team league's 104 rostered players and the next 26 on waivers.
- **What.** Each player's real week, against two forecasts made that Monday:
  - **the projection-week:** today's projection per game times his team's games, none if he is listed out or doubtful;
  - **the study's week:** the same, with REB, AST, STL and BLK replaced by the chances recipe.
- **The recipe, per category.** His chances per game over his last `n` games, times his rate of converting them over this season and the two before. That rate has `k` chances at the league's rate added in, so a small sample is pulled toward the league.
- **The other five categories** (PTS, 3PM, TO, FG%, FT%) stay the projection's.
- **Nothing from the future.** Every input comes from games before the Monday. Each run proves it on every Monday:
  - deleting, or rewriting, every game from the Monday on changes no input;
  - the same rewrite from the last game day before the Monday does change the inputs (the positive control), on every Monday checked.
- **The settings,** chosen per category on the tuning seasons only (NBA 2020-21 to 2022-23), then frozen in commit 3ee7f3a before any judged season was read:
  - the recent window: the last 5, 10 or 20 games;
  - the chances added at the league's rate: 0, 25, 100 or 400.
- **The test.** Judged once on NBA 2023-24 and 2024-25. The locked season (2025-26) was not touched.
- **The bar (S0's).** In each of the four categories, the study's error (RMSE) must fall by at least a quarter of S0's noise, with the 95% interval of the change below zero. No other category may get worse by more than its noise.

## What the data said

**On the tuning seasons** (8,840 player-weeks), where the settings were chosen:

- **REB, AST and STL:** worse than the projection at every one of the 12 settings. The least bad settings were the most cautious ones: 20 games, and 400 or 100 chances from the league.
- **BLK:** the only one to beat the projection, 1.938 → 1.911 blocks of error a week, at 5 games and 400 chances.

**On the judged seasons**, the one test that counts: worse than the projection in all four.

**Chances beat recent results, though.** Beside the bar, the study was also compared with the plainest recent forecast: his rebounds, assists, steals and blocks per game over the same last games. The chances recipe had less error than that in every category (table below). So the tracking numbers do carry something the recent box score does not. It is not enough to beat a projection built on seasons of production. Why the projection wins was not tested; what follows is a reading, not a finding. Twenty games of chances are still a short sample next to the projection's seasons, and the projection already follows his minutes and role.

**The test's games count does not change the verdict.** The historical boards carry almost no injury listing, so the week's games are overcounted for everyone (#1088): 3.31 games counted a player-week against 2.58 played, on the judged population. S3 changes no games count, but an overcount still favours whichever forecast runs lower per game. That is where the tuning seasons' BLK gain came from. There the study's blocks ran lower than the projection's (2.12 against 2.30 a player-week, with 1.71 really made), and scored at the games actually played, BLK is worse on the tuning seasons too. On the judged seasons, scored at the games actually played, the study is still worse in all four categories.

## The numbers that decide it

Study minus projection, in the week's error (RMSE, in rebounds, assists, steals and blocks a week), with the 95% paired bootstrap interval. NBA 2023-24 and 2024-25, S0's population: 50 weeks, 48 of them with players, 6,240 player-weeks. The bar is a quarter of S0's noise on the tuning seasons, as recorded on #1077.

| Category | Projection | Study | Study − projection (95%) | Bar | Passes |
| --- | --- | --- | --- | --- | --- |
| REB | 10.016 | 10.579 | +0.563 (+0.417 to +0.706) | ≤ −0.0505, interval below 0 | no |
| AST | 7.123 | 7.817 | +0.694 (+0.582 to +0.816) | ≤ −0.0388, interval below 0 | no |
| STL | 2.313 | 2.473 | +0.159 (+0.127 to +0.191) | ≤ −0.0084, interval below 0 | no |
| BLK | 1.989 | 2.013 | +0.024 (−0.017 to +0.065) | ≤ −0.0094, interval below 0 | no |

- **The other five categories** are the projection's, unchanged: difference 0.000 in each, so none gets worse.
- **Seed check** (seeds 0 to 19): the upper bound stays above zero in all 20 seeds for every target. The lowest is BLK's, +0.062.
- **Verdict: fail.** The bar asks for all four target categories; none passes. Per the rule, the recipe is not retried with a tweak.

Measured beside the bar, on the same judged population, not part of it:

| Category | Study − recent results, same games (95%) | Study − projection, at the games played (95%) | Study − projection, five moved weeks dropped (95%) |
| --- | --- | --- | --- |
| REB | −0.268 (−0.331 to −0.203) | +0.092 (+0.009 to +0.172) | +0.588 (+0.448 to +0.722) |
| AST | −0.088 (−0.165 to −0.014) | +0.034 (−0.055 to +0.128) | +0.705 (+0.579 to +0.834) |
| STL | −0.053 (−0.080 to −0.024) | +0.047 (+0.023 to +0.071) | +0.161 (+0.127 to +0.195) |
| BLK | −0.377 (−0.440 to −0.311) | +0.097 (+0.062 to +0.133) | +0.021 (−0.026 to +0.065) |

- **At the games played:** both forecasts' per-game lines times the games he really played. BLK on the tuning seasons, scored the same way (8,840 player-weeks): +0.063 (+0.040 to +0.088).
- **Five moved weeks dropped:** the week's schedule in the test is the schedule as played (#1087). Leaving out the five judged weeks whose games moved: 45 weeks, 5,590 player-weeks.
- **Weeks with nobody in them (#1090):** two of the 50 judged weeks have no player with a game (each season's opening board), so 48 weeks carry the 6,240 player-weeks. Both forecasts are scored on the same rows.

**The data behind it:**

- Tracking covers every regular-season game of NBA 2018-19 to 2024-25. Each season's tracked rebounds and assists add up to exactly the box score's.
- Every population player-week had a tracking line before the Monday, in every target, in every tuning and judged season.
- The export's box scores summed Monday to Sunday equal S0's real week for 5,463 of 5,463 judged player-weeks with a game, so the game days are right.
- A game with no tracking line for a chance is skipped for that chance. These are nearly all games with nothing to count: 96.5% of the rows with no rebound chances had no rebound, and 97.9% of the rows with no hustle line had no steal (2018-19 to 2022-23).

**The leak check, my own beside the study's:**

- **The study's check:** it passed on all 121 Mondays (71 tuning, 50 judged). The positive control changed the inputs on 121 of 121.
- **A second implementation:** written from the files alone, it agrees with the study's lines to 0 on all 48 judged Mondays with players.
- **A planted future, aimed at the study's code:** every game from the Monday on rewritten, plus a fake game on the Monday for every player. It moved the study's lines by 0.
- **The same plant one day earlier** changed them on 48 of 48 judged Mondays (43 of them with real games on the Sunday).

## What it means for your team

Nothing on the site changes. Your REB, AST, STL and BLK forecasts stay the projection's.

The lesson is narrower than the idea hoped. Over the same recent games, a player's tracking chances were a better guide to his next week than his recent rebounds, assists, steals and blocks themselves. But the projection beat both, in every category. So two weeks of boards or dimes, with or without the chances behind them, are not a reason on their own to add or drop a player. The projection's line moves only part of the way after a hot or cold run, and here that was the better forecast.

The test also showed something about the yardstick. Because the historical boards miss most injuries, every forecast here counts more games than were played, and a forecast that runs low per game looks better than it is. That is how BLK looked good on the tuning seasons. It is #1088's caveat, and it matters for any later study that changes a per-game level.

## Runs

| What | Runs |
| --- | --- |
| S0's tuning exports (the yardstick, the bar's noise) | 44942094895, 44942100340, 44942105040 (NBA 2020-21 to 2022-23) |
| Tuning chances (fit only), on commit d0d64f3 | 44971960142 (NBA 2018-19 to 2022-23) |
| Judged chances, on the frozen commit 3ee7f3a | 44974718421 (NBA 2021-22 to 2024-25) |
| Judged exports, the same export code (from #1079's runs) | 44952405832 (NBA 2023-24), 44954196831 (NBA 2024-25) |

The S0 noise reproduced here matches #1077's recorded table to the fourth decimal in every category. The judged chances run was created after the frozen commit was pushed: its head is 3ee7f3a.
