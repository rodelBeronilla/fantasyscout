# S2: a teammate's minutes when a 28-minute player is out

Issue #1080, on S0's yardstick (#1077). The code is `ops/s2_minutes.py`. The bar was written on the issue before any run. The reading of the population was posted there before any fit ([comment](https://github.com/rodelBeronilla/fantasyscout/issues/1080#issuecomment-7071085191)), and the frozen settings before any judged season was read ([comment](https://github.com/rodelBeronilla/fantasyscout/issues/1080#issuecomment-7072808192)).

## The short answer

**No, in either league.** Adding what his teammates gained in past games without him made the week's minutes worse on every tuning season, in both leagues, whatever the setting. What decided it is that these weeks are already overstated: the teammates miss games themselves, so any minutes added raise the week's error. Whether the projection already carries their bigger role was not tested. So the frozen study was the projection itself. Judged once on the judged seasons, it changed no category, and it fails its bar in all seven counting categories. It is recorded as failed and is not retried with a changed recipe.

## The basketball idea

Fantasy value moves when minutes move, and minutes move most when a starter misses time. When a player who plays 28 minutes or more sits, those minutes go somewhere: to the backup at his position, or to longer stints for the starters who are left. The team's past games without him show who got them. The projection already reads each player's recent minutes. The question was whether those past games without him tell you more than it already knows.

## What was measured

- **The absent player, as known on Monday.** He averages 28 minutes or more. He did not play in his team's last two games. His latest game was for that team, and his team plays at least twice that week. In other words, an absence already under way when the week starts.
- **Who is judged.** Each Monday, the players on such a player's team who are in S0's population or the next 100 on the board (the top 230 by value among players with a game).
- **With and without him.** Each teammate's minutes in the team's games the absent player played, and in the games he missed, this season and last. These are the averages the minutes redistribution model (#820) already holds, counted its way: a coach's DNP counts as 0 minutes, and a game the teammate missed himself counts in neither average.
- **Who started.** From the box scores: did the teammate start at least half the games beside him? Starters and bench players each fall back on the league's average gain when a teammate has few games without him.
- **What the projection already sees.** The projection blends its season minutes with the last five games at half weight. If some of those five were already without him, part of the gain is already in the projection, and only the rest is added.
- **The study's minutes.** The projection's minutes plus `w` times the gain, with the gain pulled toward the fallback by `k` games without him. The projected line is scaled by the new minutes. Production per minute, FG% and FT% stay the projection's.
- **The two settings.** They came from a short grid declared in advance: `k` in 0, 1, 3, 10, 30 or "fallback only", and `w` from 0 to 1 in quarters, where 0 is the projection. They were chosen per league on the tuning seasons only (NBA 2020-21 to 2022-23, WNBA 2021 to 2023), by the lowest error in the week's minutes. They were frozen in a commit with the noise before any judged season was read.
- **The judgement.** Once, on NBA 2023-24 and 2024-25 and WNBA 2024 and 2025, each league on its own, with S0's paired bootstrap.
- **The bar.** In each of the seven counting categories, the week's error must drop by at least a quarter of the noise, with the 95% interval below zero. No category may get worse by more than its noise. The noise is S0's measure taken on this study's own population, which is smaller and different from S0's.
- **Seen from Monday only.** Every Monday's board in these exports is identical to S0's (tuning) and S1's (judged) for the same day. A check recomputes every Monday's inputs twice: once with every game from that Monday on deleted, and once with those games rewritten. The inputs come out identical on all 121 NBA and 88 WNBA Mondays. A test shows the check catches a planted look-ahead. One exception is shared with S0's harness and every study: the week's schedule is the schedule as played (#1087).

**What could not be tested: the injury listing.** The hypothesis names players listed out on Monday. On the tuning seasons, the board lists only 0 to 14 players a Monday, and none on 10 of the 71 NBA Mondays: a partial official report. The WNBA has no listing in any season used here. Defining the group by the games he then missed would use the future. So the group is an absence already two games old. The first games of every absence, before he has missed two, are outside it.

## What the data said

**Absences like this are common.** Most NBA Mondays have 20 to 45 players of 28 minutes or more who sat their team's last two games. Some are fresh; others are long. On one mid-season Monday checked by hand (2023-01-09), 9 of the 26 had not played at all that season. Their teammates make 8,813 player-weeks on the NBA tuning seasons and 3,383 on the WNBA's.

**These teammates' weeks are overstated by games, not by minutes.** The projection-week gives them 23 to 26 more minutes a week than they play in the NBA, and 9 to 16 more in the WNBA. Most of that is games they miss themselves. Adding minutes for the absent teammate pushes the week the wrong way. Every setting with `w` above 0 was worse:

| Tuning seasons | Player-weeks | Week minutes RMSE, projection | Best with `w` above 0 |
| --- | --- | --- | --- |
| NBA 2020-21 to 2022-23 | 8,813 | 47.60 | 48.61 (fallback only, `w` 0.25) |
| WNBA 2021 to 2023 | 3,383 | 27.76 | 29.26 (`k` 0, `w` 0.25) |

**Per game played, the leagues differ.** These are readings from the tuning seasons, not part of the bar. In the games these teammates did play, they played more minutes than the projection said: 0.20 a game more in the NBA and 1.05 more in the WNBA (real minus projected). The past gain barely says who gets more: its correlation with what changed was +0.01 in the NBA and −0.02 in the WNBA. That held even for fresh absences, two to five games old (+0.00 and −0.01).

- **NBA:** adding the gain is worse per game played too, so here the projection's minutes do look close to right.
- **WNBA:** the numbers lean the other way. Per game played, adding a quarter of the gain was slightly better at every setting (minutes RMSE 6.153 against 6.185), and teammates who had gained 10 or more minutes a game without him played about 3.0 more than projected (54 player-weeks). That was computed in the study's review ([the review](https://github.com/rodelBeronilla/fantasyscout/pull/1093#issuecomment-7074493419)), with no interval and not judged. In the week it is outweighed by the games they miss.

**In the NBA, the projection may have moved already.** NBA teammates who had gained 10 or more minutes a game in past games without him (14 on average) played only 0.7 a game more than the projection said. On the judged seasons it was 1.8. A likely reason, not tested here: by the time a player has missed two games, those games are in his teammates' last five, which the projection reads. That fits what notebook 07 found in 2026-10 for the last ten games (ADR 0012).

## The numbers that decide it

The frozen study is the projection (`w` 0), so the two columns are equal by construction.

**NBA, judged seasons 2023-24 and 2024-25** (48 weeks with an absence, 5,328 player-weeks). Week minutes RMSE: 52.43 for both.

| Category | RMSE projection | RMSE study | Study − projection (95%) | Bar | Passes |
| --- | --- | --- | --- | --- | --- |
| PTS | 28.672 | 28.672 | 0.000 (0.000 to 0.000) | −0.143 | no |
| REB | 10.976 | 10.976 | 0.000 | −0.052 | no |
| AST | 7.143 | 7.143 | 0.000 | −0.038 | no |
| STL | 2.369 | 2.369 | 0.000 | −0.008 | no |
| BLK | 1.882 | 1.882 | 0.000 | −0.009 | no |
| 3PM | 3.685 | 3.685 | 0.000 | −0.016 | no |
| TO | 3.809 | 3.809 | 0.000 | −0.017 | no |
| FG% | 2.474 | 2.474 | 0.000 | no worse than 0.042 | yes |
| FT% | 1.059 | 1.059 | 0.000 | no worse than 0.022 | yes |

**WNBA, judged seasons 2024 and 2025** (29 weeks with an absence, 1,999 player-weeks). Week minutes RMSE: 29.23 for both.

| Category | RMSE projection | RMSE study | Study − projection (95%) | Bar | Passes |
| --- | --- | --- | --- | --- | --- |
| PTS | 12.675 | 12.675 | 0.000 (0.000 to 0.000) | −0.087 | no |
| REB | 5.571 | 5.571 | 0.000 | −0.035 | no |
| AST | 3.507 | 3.507 | 0.000 | −0.025 | no |
| STL | 1.571 | 1.571 | 0.000 | −0.010 | no |
| BLK | 1.093 | 1.093 | 0.000 | −0.009 | no |
| 3PM | 1.766 | 1.766 | 0.000 | −0.013 | no |
| TO | 2.352 | 2.352 | 0.000 | −0.014 | no |
| FG% | 1.628 | 1.628 | 0.000 | no worse than 0.048 | yes |
| FT% | 0.688 | 0.688 | 0.000 | no worse than 0.024 | yes |

The bars are a quarter of the noise on this population. The tuning seasons' noise was 0.571 for NBA points and 0.347 for WNBA points. For comparison, S0's whole population had 0.592 and 0.325.

## What it means for your team

- **Adding minutes for a teammate's absence did not improve the week.** Once a starter has missed two games, giving his teammates more minutes than the board shows made their week's forecast worse in both leagues, because these players' weeks already come in short from games they miss. In the WNBA, the teammates did play more per game than the board said; whether that is worth acting on was not judged.
- **In the NBA, the big gainers get a little more than the board shows, not a lot.** It's about one to two minutes a game, for the teammates who gained 10 or more without him before. That is too small to clear the bar, and too small to choose a pickup by.
- **The bigger risk in these weeks is games, not minutes.** These players' weeks come in short because they miss games themselves. That is S1's question (#1079), not this one.
- **The untested part is the first games of an absence.** When a player is ruled out before he has missed a game, his teammates' last five don't show it yet. That case needs the official listing on history, which these seasons don't have. Once listings build up, it can be its own study with its own bar.
- **Nothing changes on the site.** This is recorded as failed (`methodology/features.yml`, `teammate-out-minutes`, hidden). The "who takes his minutes" call on My Team (#763) is a different call. It stays hidden and is judged against its own bar on 2026-27's weeks.

## Reproduce

The exports come from the Backtest workflow's `teammate_out` option, one run per season with its two earlier seasons mirrored:

- **NBA:** 44963295656 (2020-21), 44965084047 (2021-22), 44968328313 (2022-23); 44976659614 (2023-24), 44978170521 (2024-25).
- **WNBA:** 44966777799 (2021), 44967227098 (2022), 44967666245 (2023); 44979725556 (2024), 44980135321 (2025).

```
uv run python -m ops.s2_minutes parity s2-nba-2020-21/ closeness-nba-2020-21/
uv run python -m ops.s2_minutes check s2-nba-2020-21/ s2-nba-2021-22/ s2-nba-2022-23/
uv run python -m ops.s2_minutes fit s2-nba-2020-21/ s2-nba-2021-22/ s2-nba-2022-23/ --out fit-nba.json
uv run python -m ops.s2_minutes judge s2-nba-2023-24/ s2-nba-2024-25/ --out s2-nba.json
```
