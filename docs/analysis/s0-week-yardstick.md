# How well the site predicts a player's week (S0)

The first step of the studies (#1077). Before trying to predict a player's week better, we measured how well the site does it now. Every later study has to beat this.

## The question

On a Monday, the site gives each player a line per game: points, rebounds, assists, steals, blocks, threes, turnovers, and his shooting. It also knows how many games his team plays that week, and whether he is listed out or doubtful. Multiply the line by the games and you have the site's guess at his week.

The simplest alternative is what a manager does in his head: take the player's average so far this season and multiply by his team's games. We call that the naive manager. If the site cannot beat it, its projection adds nothing.

## What we measured

- **Seasons:** the three seasons kept for tuning in each league (NBA 2020-21 to 2022-23, WNBA 2021 to 2023). The later seasons are kept back to judge the studies, and are not touched here.
- **Each Monday:** the site rebuilt exactly as it stood that morning, with nothing from that week's games.
- **Players:** the ones who matter in a league like yours. That is the top 104 on the board (8 teams with 13 spots), plus the next 26, the players you would pick up. Only players whose team plays that week count.
- **Shooting:** FG% and FT% are scored by makes at the attempts the player really took. A miss on a player who shoots 20 times counts more than one who shoots 5, as it does in your league.

## What the data said

The site's projection beats the naive manager in every category, in both leagues. The error below is how far the guess was from the real week, on average across a player's week (root mean square).

| NBA, per player-week | Site | Naive | Site better by |
| --- | --- | --- | --- |
| Points | 29.1 | 30.9 | 1.8 |
| Rebounds | 10.3 | 10.9 | 0.6 |
| Assists | 7.2 | 7.8 | 0.6 |
| Steals | 2.4 | 2.6 | 0.2 |
| Blocks | 1.9 | 2.2 | 0.2 |
| Threes | 3.8 | 4.0 | 0.2 |
| Turnovers | 3.9 | 4.2 | 0.3 |
| Field-goal makes | 2.9 | 3.2 | 0.2 |
| Free-throw makes | 1.3 | 1.4 | 0.1 |

The WNBA looks the same, with smaller numbers because its weeks are shorter: points 13.1 against 14.8, rebounds 5.9 against 6.6, assists 3.5 against 4.1.

Every one of these gaps is far bigger than chance. Resampling the weeks a thousand times never brought any of them near zero.

**What that means for your team.** Even the site's guess is off by about 29 points on a typical player's week. A week is short: one bad night, one rest day, one blowout moves it a lot. That is the room the studies try to win back.

**The week's schedule as of the Monday (#1087).** These numbers were first measured with each week's games as they were played. A game postponed after the Monday then sat on its new date, so the test knew on the Monday about a move made later in the week. The test now counts each Monday's games as the schedule had them that morning (how is under "Reproduce"). On the tuning seasons, 13 NBA weeks changed (most of them in the 2020-21 season, with its many postponements) and one WNBA week. The site's error grows a little, because it now also counts games that were later called off: NBA points 29.1 to 29.6, rebounds 10.3 to 10.5, assists 7.2 to 7.3. The naive manager's error grows the same way, so the site still beats it by the same margin (points 1.76 then, 1.77 now). The WNBA moves by 0.02 or less. The noise grows by up to 4% in the NBA (rebounds 0.202 to 0.209) and by less than 1% in the WNBA. The bars below stay as they were recorded on #1077. With the new noise, none would change by more than 0.0022 (NBA points 0.1480 to 0.1502, rebounds 0.0505 to 0.0524), and no study's pass or fail would differ.

## The bar every study must clear

To count, a study has to be better than the site's projection by more than the measurement's own wobble could produce. We measured that wobble by resampling (the "noise"). A study passes in a category only if it lowers the error by at least a quarter of that noise, with the improvement clear of zero, and makes no category worse by more than the noise. In the NBA that means at least 0.15 points, 0.05 rebounds, 0.04 assists, 0.008 steals, 0.009 blocks, 0.016 threes, 0.017 turnovers, 0.011 field-goal makes and 0.006 free-throw makes, per player-week. The full table, both leagues, is on #1077.

## The four studies this sets up

- **S1, games played (#1079):** who sits the second night of a back-to-back.
- **S2, minutes when a teammate is out (#1080):** who takes the minutes when a starter misses games.
- **S3, opportunity before outcome (#1081):** rebound chances and potential assists, which settle faster than rebounds and assists.
- **S4, shot diet (#1082):** where a player shoots from, which says more than a hot or cold fortnight.

Each has its own page here once it is judged.

## Reproduce

The weekly exports come from the Backtest workflow's runs listed on #1077. Each Monday's schedule as published comes from its `monday_schedule` option (runs 45086605927 for the NBA and 45090730141 for the WNBA), applied to each export with `uv run python -m ops.monday_schedule apply`. The past seasons' schedule was collected only once, after each season ended. So a game moved after the Monday is found from its number. The league numbers a season's games in the order it first scheduled them, and a postponed game keeps its number, so it sits among games played weeks earlier. On the Monday it counts on that earlier date: a move is taken to have been made after the Monday of the week it left. A game moved earlier stays where it was played, and a playoff game counts only once the regular season has ended, since that sets who plays whom. For the live season, the schedule is collected every day, and the Monday reads the copy collected before it.
