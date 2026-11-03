# 0012. Signals tested and not built

Date: 2026-10-30
Status: Accepted
Moved from: ADR 0003, its matching addenda (moved here on 2026-11-01, text unchanged)

## Context

The signals that were backtested and did not earn a place in the board, the matchup or the Streamers sort, with the evidence, so the question is not reopened without new data: defence by position, expected games, the board's line as a Streamers signal, the betting line in the matchup, a teammate's known absence, and referee crews (whose tendencies did earn the player page's tooltip but not a value). Written as addenda to ADR 0003; gathered here.

## Defence by position does not earn a place in the matchup (2026-10-30)

Issue #142 asked whether an opponent's defence against a player's position explains his game beyond the opponent's overall defence, which the matchup score already uses. The test was every player-game with 10+ minutes after a player's first five games. The measure was his fantasy points per minute (ESPN's default points) against his season average to date. Two signals were taken from what the opponent had allowed before that day: per minute to all players, and per minute to players of his primary position (G, F or C), less the overall figure. Both were standardised over the league's teams. The signals were fitted on earlier seasons (NBA 2023-24 and 2024-25, WNBA 2021 to 2024) and tested on the latest (NBA 2025-26, WNBA 2025 and 2026).

| Signal | NBA, out-of-sample share of the game-to-game swing explained | WNBA |
| --- | --- | --- |
| Overall defence | 2.25% | 1.77% |
| Overall plus defence by position | 2.26% | 1.81% |
| Defence by position alone | −0.04% | 0.02% |

One standard deviation of overall defence is worth about 1.8 fantasy points over 30 minutes in the NBA and 1.5 in the WNBA. Positional defence is worth 0.15 and 0.31, an order of magnitude less and inside the noise. Positional defence tables are mostly a sample of who happened to play against whom. So the matchup score keeps overall defence and pace, and nothing is built for positions. The stats API's defender tracking (leaguedashptdefend, boxscorematchupsv3) measures defenders rather than opponents' positions. Each needs per-game calls on the home runner, and with this result it is not worth that cost now.

## Expected games, the board's line and opportunity do not beat the Streamers sort (2026-10-30)

The streamer signals notebook tested three more signals against the Streamers default, last-ten production times the team's games in the week. The setup matches the Streamers sort addendum: every Monday of each regular season, the candidates outside the rostered pool, scored on what they add to the next seven days' category totals. The fits used earlier seasons (NBA 2023-24 and 2024-25, WNBA 2018 to 2025) and the tests the latest (NBA 2025-26, WNBA 2026). The signals were:

1. **Expected games.** Each of the team's games in the week is weighted by the chance the player plays it. The player's status is the official injury report listing on or before the Monday, unless the player has played since. The chance of missing each game comes from the spells of earlier listings with the same status and reason, point in time: a Kaplan-Meier curve over the listings before the Monday, given the games already missed. Spells still running on the Monday are censored. The WNBA uses the NBA's listings until it has 300 for the status. The second night of a back-to-back adds the extra chance of sitting out measured on the games before the Monday (over every season in the build, 2.7 points for an NBA rotation player and 1.4 for a WNBA one). Production times expected games replaces production times games.
2. **The board's projected line.** `replay.project` as of the Monday, scored on the same contribution scale, times games and times expected games.
3. **Opportunity trend.** Minutes times usage percentage over the last five games against the minutes trend's baseline, alone and in a fitted blend of every signal.

Out of sample, over all candidates, then over those whose Monday listing was not Out. Streamers hides players listed Out by default (the Health filter), so the second view is the page as a manager sees it. Top-10 hits are the week's ten best pickups found in the sort's top ten; the rank correlation is the weekly mean, with its t-statistic.

| NBA 2025-26 (23 Mondays) | Top-10 hits, all | Rank corr, all | Top-10 hits, listed Out left out | Rank corr, listed Out left out |
|---|---|---|---|---|
| Last-ten production x games (default) | 1.39 | 0.471 (t 32.5) | **1.74** | 0.539 (t 39.1) |
| Last-ten production x expected games | **1.70** (+0.30, t 2.3) | 0.578 (t 49.4) | **1.74** (+0.00) | 0.543 (t 38.1) |
| Board's line x games | 1.43 | 0.491 (t 36.8) | 1.65 | 0.546 (t 44.6) |
| Board's line x expected games | 1.52 | 0.574 (t 49.3) | 1.57 | 0.550 (t 41.9) |
| Opportunity trend | 1.17 | 0.197 (t 16.0) | 1.26 | 0.216 (t 16.0) |
| Fitted blend of every signal | 1.78 (+0.39, t 2.2) | 0.607 (t 53.0) | 1.83 (+0.09, t 0.4) | 0.589 (t 45.3) |

| WNBA 2026 (18 Mondays) | Top-10 hits, all | Rank corr, all | Top-10 hits, listed Out left out | Rank corr, listed Out left out |
|---|---|---|---|---|
| Last-ten production x games (default) | 3.28 | 0.297 (t 9.3) | 3.50 | 0.309 (t 9.8) |
| Last-ten production x expected games | 3.39 (+0.11, t 0.6) | 0.321 (t 9.9) | 3.44 (-0.06) | 0.307 (t 9.5) |
| Board's line x games | **3.89** (+0.61, t 1.9) | 0.322 (t 11.0) | 3.83 (+0.33, t 1.0) | 0.334 (t 12.1) |
| Board's line x expected games | 3.83 | 0.343 (t 11.3) | **3.89** (+0.39, t 1.1) | 0.331 (t 11.3) |
| Opportunity trend | 1.78 | 0.083 (t 2.3) | 1.83 | 0.078 (t 2.2) |
| Fitted blend of every signal | 1.89 | 0.257 (t 9.8) | 2.44 | 0.292 (t 11.9) |

The top decile of NBA expected-games production adds 13.6 to the week above the average candidate, against 10.3 for the default. In the WNBA the figures are 4.0 against 3.9.

**Expected games carries only what the Health filter already does.** About 17% of NBA candidate-weeks belong to a player listed Out on the Monday. Their last ten games still rank them high, and they then add about 4 to the week against 14 for an unlisted candidate. Weighting by expected games pushes them down, which is all of its gain. With them left out, it finds the same 1.74 pickups as the default, and Doubtful, Questionable and back-to-back weights change nothing measurable. The page's default filter has the same effect at no cost, so the filter is worth keeping as the default.

**The board's line helps the WNBA and not the NBA.** It found 0.3 to 0.6 more pickups a week in the WNBA (t about 1 to 2) but fewer in the NBA, where the last ten games follow a role change faster than the season-weighted line does. **Opportunity** trends the right way (rank correlation 0.2 NBA, 0.08 WNBA), but less than minutes alone, and the blend gives it almost no weight. **The fitted blend** gains in the NBA because the 2023-24 and 2024-25 seasons it was fitted on carry the listings. It falls far behind in the WNBA, whose fitted seasons have no listings, and its weights on the near-copies of production cancel each other out.

No signal clearly beats the default for the NBA without costing the WNBA, so **the Streamers sort and `mart_streamers` stay as they are.** The notebook keeps the three signals and reports both views each build. As the WNBA's own listings and the NBA's 2026-27 season accumulate, a gain that holds with players listed Out left out would reopen the question. The board's line for the WNBA alone is the candidate to watch.

## The betting-line backtest (2026-10-30)

The betting lines addendum promised a backtest before the line moves any score. Notebook 03 now runs it, in three parts.

- **Coverage.** The share of each league-season's played games with a closing line in `fct_game_line`.
- **Does the line add to defence and pace?** The team's implied points (standardised over the league-season's team-games with a line) and the absolute spread per 5 points (blowout risk) join the opponent's defence and pace in the effects framework. The outcomes are fantasy points per 30 minutes and minutes, each against the player's own figure so far, with the minutes tier as a control, for all regulars and split by whether they started. Reported: effects with player-bootstrap intervals, and the share of the outcome the line explains out of sample beyond defence, pace and the tier.
- **Which matchup predicts better?** The current matchup (`fantasy_matchup`, computed as `mart_schedule_upcoming` does) against a line matchup (implied team points less the league-season average). Each gets one slope on the fit part, and both are scored out of sample on the same test games, for fantasy points in the game and per 30 minutes.

ESPN's summaries keep the line only for recent games. Probed on 2026-10-30, every NBA summary from 2025-11-25 on carried DraftKings' closing line, and none before it did. Every WNBA 2026 summary carried one, and no WNBA 2025 summary did. So each league has one finished season with lines, unless the build landed older summaries while they still had them. With one season, the notebook fits on its first half by date and tests on the second. Earlier seasons fit once they have lines too. With fewer than 500 player-games with a line on either side, the league is reported as accumulating.

The run here used a sample, not the published build. Box scores for every regular-season game of NBA 2023-24 to 2025-26 and WNBA 2023 to 2026 came from ESPN's summaries, the set the referee addendum used, so box scores and pace are ESPN's. Closing lines came for a random 260 NBA 2025-26 games (198 with a line) and 200 WNBA 2026 games (199). The NBA test is 2025-26 games from 2026-01-27 on (about 1,860 player-games); the WNBA test is 2026 games from 2026-07-17 on (about 1,480).

| Test part, 95% intervals from resampling players | NBA 2025-26 | WNBA 2026 |
| --- | --- | --- |
| Implied team points, per SD: fantasy pts / 30 min | +0.62 (-0.03 to +1.46) | -0.30 (-1.06 to +0.79) |
| Absolute spread, per 5 points: starters' minutes | -0.54 (-0.98 to -0.21); fit part -0.77 | -0.45 (-0.69 to -0.14); fit part -0.09 |
| Absolute spread, per 5 points: bench minutes | +0.69 (+0.17 to +1.30); fit part +0.56 | +0.27 (-0.52 to +0.94) |
| Share explained beyond defence, pace and tier: fantasy pts / 30 min | +0.35% (-0.06 to +0.78) | +0.11% (-0.34 to +0.63) |
| Share explained beyond defence, pace and tier: minutes | +1.56% (+0.64 to +2.25) | +0.19% (-0.41 to +0.72) |
| Fantasy pts in the game, explained beyond tier: defence + pace matchup | +1.26% (+0.53 to +1.78) | +2.22% (+1.24 to +3.07) |
| Fantasy pts in the game, explained beyond tier: line matchup | +0.01% (-0.61 to +0.57) | +0.35% (+0.01 to +0.61) |
| Line matchup minus defence + pace (percentage points) | -1.25 (-1.88 to -0.64) | -1.87 (-2.58 to -1.13) |

The line does carry the blowout. A wider spread takes about half a minute per 5 points from a starter. That holds in both halves of the NBA season and in the WNBA's second half, though not its first (-0.09). NBA bench players gain about as much. Implied points add little to production per minute once defence and pace are in, and the gain in explained variance is under half a percent with an interval that reaches zero. As a matchup on its own, implied team points are clearly worse than defence and pace, in both leagues and per game or per 30 minutes. A likely reason: implied points mostly restate a team's own offence, which the player's own rate already carries. Adding the line to the current matchup adds about nothing (NBA +1.12% together against +1.26% alone; WNBA +2.38% against +2.22%).

**The matchup value is unchanged.** On this sample the line does not beat defence and pace, and its one clear effect, minutes in a lopsided game, is about half a minute per 5 points. That is too small to move a value per game, and it splits starters from bench, which the matchup value does not do. Streamers keeps showing the line as context. On the published build, the notebook's findings will show whether the minutes effect holds over full seasons and whether the line still trails the current matchup. If both hold, the decision stands and the 'to confirm' mark comes off. If the line's minutes effect proves larger, a role-aware minutes adjustment is the place for it, not the matchup.

**Published build (run 41164519437).**
- **Coverage:** ESPN keeps closing lines only on recent summaries, so lines cover NBA 2025-26 from late November (80% of games) and 2026-27, and WNBA 2026 (99%).
- **The line as a matchup:** it explains less than defence and pace. Out of sample it is 1.41 fantasy points a game worse in the NBA (-1.68 to -1.21) and 1.17 worse in the WNBA (-1.61 to -0.59).
- **The line added to defence and pace:** it explains 0.33% more of fantasy points per 30 minutes in the NBA and 0.20% in the WNBA.
- **Minutes:** it explains 3.0% more of NBA minutes and 0.3% of WNBA minutes. The source is blowout risk: each 5 points of spread costs NBA starters 0.73 minutes (-0.93 to -0.51) and WNBA starters 0.37.

The matchup stays defence and pace. The spread's cost to starters is real but small: a 10-point favourite's starter loses about a minute and a half. It is a candidate for a minutes adjustment on game days, not a change to weekly value.

## A teammate's known absence is real, but the last ten games already price who gains (2026-10-30)

The in-season minutes addendum found that the minutes of teammates who sat out the latest game add nothing beyond the last five games. Notebook 07 (`07_teammate_absence`) asks a wider question. It uses absences known in advance and targets production and usage over the following week, not only minutes.

**Known in advance.** Where the official injury report covers the game (`fct_official_listing`: NBA 2023-24 on, WNBA 2026), a teammate listed Out who then did not play. Elsewhere, an approximation: a teammate who missed the team's previous game and this one. About three in four absences are part of such a spell. The run below used the approximation throughout, because the local copy of history carries no listings. The published build has them for the NBA, and `notebooks.yml` runs the branch's notebook on it.

**The measure.** A teammate's share is minutes per game so far over the team's minutes, or usage share: usage rate times minutes per game over the game's length. Last season stands in before a teammate's fifth game. Usage shares add to 1 over a team's game. The absence is the known-out share the player's own baseline does not already hold. Each known-out teammate's share counts in proportion to how many of the player's baseline games that teammate played. It is split into teammates at the player's position (G, F or C) and the rest.

**(a) Game by game.** Every regular-season game a player played, with five or more games and 10+ minutes a game so far. Each outcome is measured against the player's season to date. The model is fitted on the earlier seasons and estimated again on the latest finished season, NBA 2025-26 and WNBA 2026, with 95% player-bootstrap intervals. Effects are per 10 points of share newly out. A top teammate is about 20 points of usage share.

| Per 10 points newly out, latest season | NBA, same position | NBA, other | WNBA, same position | WNBA, other |
| --- | --- | --- | --- | --- |
| Minutes | +1.98 (+1.64 to +2.25) | +1.38 (+1.13 to +1.60) | +1.33 (+0.81 to +1.98) | +1.14 (+0.72 to +1.44) |
| Usage, percentage points | +0.71 (+0.53 to +0.85) | +0.74 (+0.62 to +0.87) | +0.49 (+0.11 to +0.88) | +0.59 (+0.34 to +0.82) |
| Fantasy points per 36 minutes | +0.61 (+0.18 to +1.05) | +0.68 (+0.45 to +0.95) | -0.05 (-0.96 to +1.13) | -0.68 (-1.47 to -0.14) |
| Fantasy points per game | +2.08 (+1.69 to +2.46) | +1.63 (+1.27 to +1.95) | +1.18 (+0.56 to +1.92) | +0.49 (-0.05 to +1.07) |
| Production per game (Streamers unit) | +0.64 (+0.46 to +0.84) | +0.50 (+0.34 to +0.65) | +0.35 (+0.04 to +0.78) | -0.03 (-0.34 to +0.30) |

The earlier seasons' estimates agree in size. Bench players gain about twice the minutes starters do: in the NBA, +2.36 and +1.83 minutes against +1.13 and +0.79. The gain is mostly minutes and a little usage. Production per minute barely moves, and in the WNBA not at all. Out of sample, the absence explains 4.3% of the game-to-game swing in NBA minutes, 1.8% of fantasy points per game and 0.6% of production; in the WNBA, 1.7%, 0.3% and nothing.

**(b) Monday replays.** On every regular-season Monday, each team's top teammate is the one with the largest usage share so far. The study takes the teams whose top teammate was known out for the whole week. That was 256 of 2,070 NBA team-weeks and 71 of 1,360 WNBA team-weeks. The affected players are the team's other players with five or more games who played that week: 2,941 NBA and 681 WNBA player-weeks, of which 1,166 and 187 fall in the test seasons. Four predictors of their production per game that week:
- the last ten games;
- the last ten plus a flat uplift, the earlier seasons' average change;
- the last ten plus the redistribution: the slopes from (a), fitted on the earlier seasons, times the share newly out against the last ten games;
- the last ten plus the player's own split this season without the teammate against with them, shrunk by five games.

| Fantasy points per game, test season | NBA 2025-26: mean abs. error | Gain on the last ten | Bias | WNBA 2026: mean abs. error | Gain on the last ten | Bias |
| --- | --- | --- | --- | --- | --- | --- |
| Last ten | 7.74 | | -2.19 | 6.95 | | -0.48 |
| Plus a flat uplift | 7.65 | +0.09 (+0.02 to +0.18) | -0.59 | 7.09 | -0.14 (-0.33 to +0.04) | +0.99 |
| Plus the redistribution | 7.71 | +0.03 (-0.14 to +0.17) | +0.10 | 7.02 | -0.07 (-0.34 to +0.21) | +1.41 |
| Plus the player's own split | 7.73 | +0.02 (-0.07 to +0.13) | -1.49 | 7.17 | -0.22 (-0.45 to +0.01) | +0.01 |

In the Streamers unit, production per game, the redistribution changed the error by -0.015 (-0.058 to +0.029) in the NBA and -0.10 (-0.22 to +0.01) in the WNBA. For minutes alone, the player's own split was a small gain in both leagues: +0.11 (+0.03 to +0.17) and +0.13 (+0.01 to +0.30) minutes, against errors of 4.6 and 4.3.

**The uplift is real, and the last ten games cannot see it.** Over every player-week, the last ten games are close to unbiased (NBA -0.13 fantasy points a game, WNBA -0.04). For players whose top teammate is out all week they fall short by 2.2 in the NBA, 1.6 in the earlier NBA seasons, and 0.5 to 1.5 in the WNBA. The redistribution sizes the NBA uplift almost exactly (+2.3 against +2.2) but not who receives it. Its move correlates 0.07 with the change that followed in fantasy points and 0.01 in production; in the WNBA it is 0.24 and 0.15, and it overshoots. A week of three or four games swings by about 10 fantasy points a game, so an average 2-point shift spread unevenly over eight players does not lower the absolute error. The flat uplift's gain in the NBA, about 1%, does not hold in the WNBA.

**Nothing is built.** There is no `fct_usage_redistribution` model and no Streamers column. On the measure that ranks streamers and feeds window value, neither the redistribution nor the player's own split beats the last ten games. That is true in either league, out of sample. The one consistent gain, under a minute a game, is too small to be worth a model. Per-minute production barely moves when a teammate is out, so lineup on/off splits from `fct_event`, which measure per-minute effects, are not worth building on this evidence. The notebook re-runs on every build. On the published build, the games the official report covers (NBA 2023-24 on, WNBA 2026) use the listings in place of the approximation.

## Referee crews, and whether their tendencies carry over (2026-10-30)

Two sources name the officials. ESPN's game summaries, already landed for every played game, list each crew (three names in an order, every one called "Referee"); `bronze.espn_summary_officials` reads them, so the history needs no new requests. The leagues post the day's assignments at about 9 am Eastern on official.nba.com, one page with an NBA and a WNBA table: each game's crew chief, referee, umpire and sometimes an alternate, with uniform numbers. The reports run lands that page parsed into one JSON row per game, once per Eastern day and league, keyed by the date the page is for (`ingest/referee_assignments.py`; robots.txt allows the path). An off day's empty table, or a page with no table, records nothing. The 7 pm Eastern reports run, and the build after it, put that night's crews on the site.

`silver.game_officials` gives one row per game and official. A played game takes ESPN's crew through `game_xwalk`, with the role from the page where it named the same official. A game ESPN has no crew for yet takes the page's crew, linked by date and the two team names the page uses ("L.A. Lakers", "LA Clippers", "Golden State") through the teams seed and the schedule's tricodes. Officials match across the sources by name reduced to lowercase letters, so "J.B. DeRosa" and "JB DeRosa" agree. `gold.fct_referee_tendency` compares each official's regular-season games in a league-season with the league-season's average game: total fouls, free-throw attempts, points and pace. In `mart_schedule_upcoming`, a crew's tendency averages its three officials over this season and last, each shrunk toward zero as if they had also worked 20 average games. Streamers' week grid (in the tooltip) and the player page's next games show the crew chief and that tendency. dbt unit tests pin the linking, the tendency arithmetic and the crew average.

Does a crew's record say anything about the next game? Notebook 03 tests this point in time. Each official's tendency comes only from the games they worked before, and the effects framework above is fitted on the earlier seasons and checked on the latest finished one, with player-bootstrap intervals. The run used 4,803 regular-season games (NBA 2023-24 to 2025-26, WNBA 2023 to 2026) rebuilt from ESPN's summaries into the three tables the section reads. Box scores and pace there are ESPN's, not the league's. The notebook runs the same code on the lakehouse's gold tables on every export. Crews with 30 or more prior games between them:

| Latest season, per unit of crew tendency | NBA 2025-26 | WNBA 2026 |
| --- | --- | --- |
| Crew tendency, SD (free-throw attempts a game) | 0.67 | 0.54 |
| The game's free-throw attempts: slope, correlation | +0.72, 0.04 | +0.87, 0.04 |
| The game's fouls: slope, correlation | +1.06, 0.07 | +1.29, 0.07 |
| Player free-throw attempts / 30 min, per attempt of tendency | +0.02 (-0.02 to +0.09) | +0.05 (-0.10 to +0.19) |
| Player fouls / 30 min, per attempt of tendency | +0.01 (-0.03 to +0.05) | -0.04 (-0.13 to +0.08) |
| Fantasy pts / 30 min, per attempt of tendency | -0.09 (-0.37 to +0.18) | +0.44 (-0.19 to +1.35) |
| Fantasy pts / 30 min, per possession of pace tendency | +0.20 (-0.33 to +0.80) | -0.13 (-1.98 to +1.31) |
| Share of fantasy pts / 30 min explained out of sample | +0.002% | +0.002% |

Crews differ, and some of the difference carries over: a crew whose games have run one free-throw attempt above average sees about 0.7 to 0.9 more in its next game. But crews differ little against a game-to-game spread of about 11 attempts. Their tendency explains under half a percent of a game's free throws, and nothing measurable of a player's free throws, fouls or fantasy production. The one interval clear of zero for NBA player free throws, in 2024-25 (+0.11, +0.06 to +0.18), did not hold in 2025-26. The WNBA's fouls-on-pace estimate (+0.27, +0.04 to +0.55) did not replicate in earlier seasons (+0.09). **The crew stays out of the value.** It is shown as context, like rest and altitude, and the notebook re-tests it as seasons accumulate.

## Addendum (2026-11-02): when the betting line's minutes effect is confirmed

The matchup decision carries a "to confirm" mark until the line's minutes effect has full seasons behind it. The closing lines start in October 2026, so the first full season with them is NBA 2026-27, complete in April 2027; the game context notebook's findings after it confirm the decision or reopen it (#492). The prop lines' own comparison against outcomes waits for 200 player-game markets over 7 game dates per league, and its notebook fact now names both counts.

## Three backtests run ahead of their retests: none adopted (2026-11-03)

Three audit findings (#487, #493, #488) proposed changes to the board and Streamers, each with a bar to clear out of sample. They were run on the published build (the `Run the notebooks` workflow on their branches) rather than left for the next season.

**Shooting percentages shrunk toward the pool (#487, run 41565973493).** Each projected FG%, FT% and 3P% was pulled toward the pool's rate by notebook 05's stabilization attempts (78/31/340 NBA, 84/34/299 WNBA), attempt rates unchanged and points following the makes, and the board was replayed beside the built one. It made the projection worse:

| Out of sample | NBA built | NBA shrunk | WNBA built | WNBA shrunk |
| --- | --- | --- | --- | --- |
| FG%: attempt-weighted error | 0.039 | 0.046 | 0.051 | 0.054 |
| FG%: slope of realised on projected | 0.73 | 0.28 | 0.66 | 0.51 |
| FT%: attempt-weighted error | 0.059 | 0.061 | 0.066 | 0.066 |
| Season-total top-N hits | 0.680 | 0.667 | 0.624 | 0.600 |
| Value per game, error | 1.81 | 1.82 | 2.18 | 2.33 |

One pool rate erases differences that are real: a center's field-goal percentage is not a guard's. The stabilization points say how fast a player's percentage settles against players like them, not against the whole pool. Not built. The notebook section was not kept, since it doubled the board replay to show a method that lost; a position-aware prior is the version still worth trying.

**Games share from the player's own injury listings (#493, run 41565617995).** At each checkpoint, the share of the team's games before it, that season and the last, for which the player was listed Out for an injury. Realised share was fitted on the board's share and that listed share in the tuning seasons (NBA, 3,607 player-checkpoints), then scored on the later ones (1,399). Correlation with the share played rose from 0.573 to 0.591, short of the +0.05 bar. Season-total top-N hits, with each total rescaled by the new share, fell from 0.680 to 0.673. Given the board's share, the listed share's coefficient came out positive (+0.22). So frequent listings carry no sign of fewer games to come beyond what the board's share already holds, and the run does not say why the sign is positive. The WNBA report starts in 2026, so it has no later checkpoints to score. Not adopted. The comparison stays in notebook 01 and re-runs on every build.

**Tracking signals for Streamers (#488, run 41566156843).** Two NBA-only trends were built the way the opportunity trend is: touches a game, and potential assists per 36 minutes, each over the last five games against a baseline. Over 23 test weeks they trend the right way, with rank correlation 0.21 for touches and 0.06 for potential assists. But both fall well short of the default sort's 0.47, and as the sort they find fewer of the week's top-10 pickups: −0.074 a week for touches (t −3.7) and −0.122 for potential assists (t −7.9), against a bar of +0.3 at t ≥ 2. Not built as a column. The signals stay in notebook 02, which re-runs on every build.
