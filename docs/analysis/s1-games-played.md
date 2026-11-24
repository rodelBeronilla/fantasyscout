# S1: the games a player actually plays in the week

Issue #1079, on S0's yardstick (#1077). The code is `ops/s1_games_played.py`; the bar and the two readings of it were written on the issue before any run.

## The short answer

**In the NBA it passed its bar, but mostly for a reason other than the idea.** Counting a player's second nights of back-to-backs at his own habit of sitting them predicts his week better than counting every game his team plays: it passed in all seven counting categories on both judged seasons. But most of that gain comes from counting fewer games at all, and a flat discount on every game gets about 70% of it without looking at back-to-backs. Second nights do matter for the players you roster: a top-130 player sits about one in eight of them, against about one in fourteen of other nights. But that is a small part of the games a week overcounts, so moving the discount onto second nights does not measurably change the week's error. What is specific to the idea beyond that is each player's own record of sitting, and that part is small. **In the WNBA, no.** Back-to-backs are too rare there to move a week.

The NBA result is evidence, not yet proof. Those judged seasons have been used by every number fitted so far, so the rule says 2026-27's weeks must confirm it first. Until then it stays off the site.

## The basketball idea

A week's totals are mostly per-game production times games played, and games played is the part that swings. The projection counts every game the team has that week, and none for a player listed out or doubtful on Monday. Real players play fewer. Some of that is foreseeable on Monday:

- **Rest on back-to-backs.** Teams sit players on the second of two nights in a row. It is a habit that follows the player: age, minutes load, and how his team manages him. It shows up in his past seasons.
- **The injury listing.** Who is listed questionable or doubtful, and how often a listing like that ends in a missed game.

## What was measured

- **Who:** each Monday, the top 130 on the board among players with a game that week (eight teams of 13, plus a waiver pool of 26). This is S0's population.
- **His rest pattern, as of the Monday:** every back-to-back where he played the first night, and whether he sat the second. Both nights come before the Monday, this season and the two before. Earlier seasons count for less (the decay). His share is pulled toward the share of the whole group (by `k` back-to-backs' worth), so that two back-to-backs do not make a habit.
- **His predicted week:** each team game counts 1, and a second night counts 1 minus his share. A player listed out or doubtful counts for no games, as before.
- **The two settings** (`k` and the decay) came from a short grid declared in advance. They were chosen per league on the tuning seasons only (NBA 2020-21 to 2022-23, WNBA 2021 to 2023), by the lowest error in games played. They were frozen in a commit before any judged season was read.
- **The judgement:** once, on NBA 2023-24 and 2024-25 and WNBA 2024 and 2025, each league on its own. For each category, the error (RMSE) of the week's total is compared with the projection-week's, with S0's paired bootstrap for the 95% interval.
- **The bar** comes from S0. In each counting category the error must drop by at least a quarter of S0's noise, with the interval below zero. No category of the nine may get worse by more than its noise. FG% and FT% are scored at the real attempts, so the games count cannot move them. They are held only to "no worse".
- **What the study knew on the Monday.** A check recomputes every Monday's inputs and predicted games with every game from that Monday on deleted, and the results are identical on every tuning and judged Monday (121 NBA, 88 WNBA). One thing was not as of the Monday when the study was judged: the week's schedule was the schedule as played, not as published that morning, so a game postponed later in the week already sat on its new date. #1087 fixed that in S0's harness: each Monday now counts the games its schedule had. It changes four NBA judged weeks (2024-01-15, 2025-01-06, 2025-01-20, 2025-03-17) and the last week of each WNBA season, whose playoff Sunday was not yet set on the Monday. The result barely moves and the verdicts stand. NBA PTS was −0.836 (−0.999 to −0.687) and is −0.832 (−0.994 to −0.684); every counting category still passes. WNBA PTS was −0.016 and is still −0.016, and the WNBA still fails. A player whose team had a game moved now keeps the Monday's count for that week, with no rest discount.

**What could not be tested:** the injury listing. The injury history the study named (ESPN's statuses) starts in late October 2026. The official report starts in NBA 2023-24, so no tuning season has one to fit on. The listing rule stays as the projection has it. That half of the hypothesis is untested, and it waits for listings to accumulate.

## What the data said

**NBA players miss far more games than the schedule says.** Among the top 130, a week has about 3.3 team games, and they play about 2.6 of them. More than half of these player-weeks include a second night. About one second night in nine was sat by a player who had played the night before. That share was 11% in both judged seasons and in the tuning seasons.

**Most of the gain is a smaller games count, not the back-to-back.** In these tests the projection-week counts every scheduled game for a player who is not listed, and the historical boards almost never carry the injury listing (2 of 6,240 judged NBA player-weeks), so it counts about 0.7 games a week too many. Any discount helps against that. A second review ran placebos on the judged NBA seasons (PTS, change in week RMSE against the projection-week):

| What is counted | PTS RMSE change |
| --- | --- |
| The study: each player's own share on second nights | −0.836 |
| The group's share on second nights | −0.614 |
| The same total discount spread over every game, no back-to-back used | −0.587 |
| The same discount handed to random players | −0.545 to −0.568 |
| Every game counted at 0.80 | −3.073 |

- **Second nights matter, but they are a small part of the count.** After a game he played, a player whose next game fell in a week he was in the top 130 sat a second night 13.3% of the time (n 2,893) and any other night 7.2% (n 13,401), on the judged seasons; 13.7% against 6.6% on the tuning seasons. That ratio, about two, holds in each of the five seasons. Across all players, bench included, it is 16.4% against 14.0% (judged seasons). Yet the group's share on second nights is not distinguishable from the same discount on any game, PTS −0.027 (−0.080 to +0.029): that discount is small next to an overcount of about 0.7 games a week, too small to tell where it lands.
- **What is specific is each player's own record.** Over a flat discount of the study's own size it adds PTS −0.218 (−0.355 to −0.087), past a quarter of the noise in only four of the seven categories (PTS, REB, BLK, TO). The study cannot say whether that record is a rest habit or a sign of a player who is currently hurt.
- **A cruder rule does far better.** Counting every game at 0.80 lowers the error by 3.07 points, nearly four times the study. That is a finding about the test's baseline, which lacks the listing, more than about rest.

**The WNBA has almost nothing to find.** Only 4% of tuning player-weeks, and 14% of judged ones, include a second night. The share sat is 3% to 6%. The best setting moved the games error by a thousandth.

## The numbers that decide it

**NBA, judged seasons 2023-24 and 2024-25** (50 weeks, the first two before any games; 6,240 player-weeks; `k` 0, decay 0.25). Games-played RMSE: projection 1.398, study 1.347.

| Category | RMSE projection | RMSE study | Study − projection (95%) | Bar | Passes |
| --- | --- | --- | --- | --- | --- |
| PTS | 28.116 | 27.280 | −0.836 (−0.999 to −0.687) | −0.148 | yes |
| REB | 10.016 | 9.738 | −0.279 (−0.336 to −0.226) | −0.051 | yes |
| AST | 7.123 | 6.971 | −0.151 (−0.186 to −0.119) | −0.039 | yes |
| STL | 2.313 | 2.281 | −0.032 (−0.038 to −0.025) | −0.008 | yes |
| BLK | 1.989 | 1.953 | −0.036 (−0.052 to −0.023) | −0.009 | yes |
| 3PM | 3.710 | 3.642 | −0.068 (−0.085 to −0.052) | −0.016 | yes |
| TO | 3.745 | 3.662 | −0.083 (−0.101 to −0.065) | −0.017 | yes |
| FG% | 2.885 | 2.885 | 0.000 | no worse than 0.045 | yes |
| FT% | 1.258 | 1.258 | 0.000 | no worse than 0.025 | yes |

Each NBA season also passes on its own. PTS: −0.60 (−0.76 to −0.43) in 2023-24 and −1.06 (−1.29 to −0.84) in 2024-25.

**WNBA, judged seasons 2024 and 2025** (37 weeks, five of them without games: two before the season, three in the 2024 Olympic break; 4,160 player-weeks; `k` 1, decay 1). Games-played RMSE: projection 1.470, study 1.465.

| Category | RMSE projection | RMSE study | Study − projection (95%) | Bar | Passes |
| --- | --- | --- | --- | --- | --- |
| PTS | 13.785 | 13.769 | −0.016 (−0.033 to +0.002) | −0.081 | no |
| REB | 5.924 | 5.919 | −0.006 (−0.011 to −0.000) | −0.035 | no |
| AST | 3.872 | 3.864 | −0.009 (−0.017 to −0.002) | −0.021 | no |
| STL | 1.762 | 1.760 | −0.002 (−0.004 to −0.000) | −0.008 | no |
| BLK | 1.219 | 1.218 | −0.001 (−0.002 to +0.000) | −0.008 | no |
| 3PM | 1.964 | 1.963 | −0.001 (−0.003 to +0.001) | −0.012 | no |
| TO | 2.583 | 2.579 | −0.004 (−0.007 to −0.002) | −0.013 | no |
| FG% | 1.938 | 1.938 | 0.000 | no worse than 0.039 | yes |
| FT% | 0.851 | 0.851 | 0.000 | no worse than 0.022 | yes |

The WNBA study is a hair better everywhere, but nowhere near its bar. It is recorded as failed and is not retried with a changed recipe.

## What it means for your team

- **Your week's games are fewer than the schedule shows.** For a top-130 NBA player it is about 2.6 played to 3.3 scheduled. A second night of a back-to-back roughly doubles a rostered player's chance of sitting (about 13% against 7%), but it is still a small part of the 0.7 games a week. A player's own recent record of sitting adds a little more.
- **Back-to-backs are a small part of the gap.** Most of the missing 0.7 games a week is injuries and other absences that the rest pattern does not see. The injury listing could not be tested on history. It is the next thing to measure as the listings build up.
- **Nothing changes on the site yet.** The NBA rule is recorded as passed on its judged seasons (`methodology/features.yml`, `week-games-rest-nba`). Wiring it into the matchup card, and into the preview you see as owner, is separate work. It shows publicly only after six live weeks of 2026-27 agree with this result. Live, the projection carries the injury listing, so the gain there is expected to be smaller than in these tests; whether that confirmation should also be held against a flat discount is yours to decide (it goes to you in the digest of Monday, 2026-11-23). The WNBA rule is recorded as failed (`week-games-rest-wnba`).

## Reproduce

The boards come from the Backtest workflow's weekly exports: S0's six tuning runs, and runs 44952405832, 44954196831, 44956085033 and 44958765100 for the judged seasons (`closeness=true`). The game rows and schedules come from its `games_played` option: runs 44949661176 (NBA) and 44948249988 (WNBA) for the tuning seasons, and the same four runs for the judged ones.

```
uv run python -m ops.s1_games_played check closeness-nba-2020-21/ ... --games s1-games-nba-history/
uv run python -m ops.s1_games_played fit closeness-nba-2020-21/ ... --games s1-games-nba-history/
uv run python -m ops.s1_games_played judge closeness-nba-2023-24/ closeness-nba-2024-25/ \
    --games s1-games-nba-2023-24/ s1-games-nba-2024-25/ --s0 s0.json --out s1-nba.json
```
