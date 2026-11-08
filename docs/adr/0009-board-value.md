# 0009. Board value

Date: 2026-10-29
Status: Accepted
Moved from: ADR 0003, its matching addenda (moved here on 2026-11-01, text unchanged)

## Context

How the board values a player: the projection, the two-pass pool and replacement level, the settings chosen by backtest, and what was tried on the value's spread, on minutes in season and after an absence, and on age. These decisions were written as addenda to ADR 0003 (gold modelling) as they were made; they are one subject and live here.

## Board value (2026-10-29)

The first board blended each season's z-scores, which had three faults on the live data. A missing season handed its weight to the others, so three games could carry a player's whole value (13th in the NBA). Zero meant "average of the top 180", so scaling by availability lifted injured below-average players (310th to 109th). And anyone with games in three seasons was listed, retired or not.

**Only rostered players.** The board lists players on their team's latest roster landing for the league's latest roster season (`silver.rosters`); an error-severity check holds it. Injured players stay, since they are still rostered.

**Project, then score once.** `mart_player_projection` gives every rostered player one per-game line: the current season and the two before it, each counted by games played times a recency weight (1.0, 0.25, 0.08), plus `prior_games` games of a replacement-level line (3 NBA, 5 WNBA). The replacement line is the average of the players just outside a fantasy league's rosters by total minutes in the latest complete season. A missing season adds nothing instead of handing its weight on.

**Value above replacement.** `mart_board` scores the projections in two passes: z-scores over the `pool_size` players with the most projected minutes, then again over the `pool_size` players the first pass values most (pool size is teams x roster spots: 12 x 13 NBA, 10 x 10 WNBA). Each category then has replacement level subtracted, the average of the next `teams` players, so zero is a freely available player and a punt build is the sum without the punted columns. Rest of season scales only value above replacement: a game missed by a player not worth rostering costs nothing.

**Settings chosen by backtest.** Seasons 2021 to 2026 (WNBA) and 2024-25 to 2025-26 (NBA) were replayed before the season and a tenth, a quarter and half way in, ranking players with each method and comparing with per-game value over the rest of the season (players with 15 or more games after). Means over the checkpoints:

| Measure | Previous blend | Projection |
| --- | --- | --- |
| Share of predicted top 50 NBA / top 30 WNBA that finish there | 0.636 | 0.657 |
| Share of the predicted rostered pool that finishes in it | 0.717 | 0.722 |
| Rank correlation among players who finish in the pool | 0.711 | 0.710 |

The gain is at the top of the board and in who is worth rostering at all; ordering inside the pool is unchanged. Recency weights from 0.15 to 0.5 for last season and priors from 0 to 20 games were tried. A heavier prior helped the WNBA at every checkpoint. For the NBA, priors above 3 games lost rostered-pool hits early in the season.

Consequences: values are on a new scale (zero is replacement, not the pool average), the projected line is published with the board and shown in the app, and the settings live in the `fantasy` and `fantasy_recency` vars.

**Minutes and games played (2026-10-29).** The projection now separates how much a player plays from what they do while playing. Minutes per game are counted by games played times a minutes recency weight. That weight is the production weight for the NBA, and 1.0, 0.06 and 0.02 for the WNBA, whose roles move more between seasons, so a change of role there shows within a few games. Production is per minute, counted by minutes played, so 60 games at 8 minutes count for far less than 60 at 34. The per-game line is the rate times projected minutes. A games share, the share of team regular-season games played in the seasons the player appeared, regressed toward 0.8 by 10 NBA or 60 WNBA games, turns value per game (`value_per_game`) into `value_total`; the app can switch it off. Regular season only: playoff games would make every team that missed the playoffs look as if its players sat out. Backtest against the previous projection, same checkpoints, with a second target of value per game above replacement times the share of games played:

| League | Measure | Previous | Minutes and games |
| --- | --- | --- | --- |
| NBA | Per game: top 50 / rostered pool | 0.650 / 0.747 | 0.650 / 0.747 |
| NBA | Season total: top 50 / rostered pool | 0.580 / 0.759 | 0.590 / 0.762 |
| WNBA | Per game: top 30 / rostered pool | 0.665 / 0.710 | 0.697 / 0.712 |
| WNBA | Season total: top 30 / rostered pool | 0.665 / 0.762 | 0.699 / 0.767 |

Past games played predict future games played only weakly: durability helped the NBA season-total ranking, while for the WNBA every regression strength from 5 to 120 games scored within a tenth of a point, hence the heavy 60.

**Context: team changes, matchups, early samples, short games (2026-10-29).** Asked how the board accounts for players on new teams, how players are used now, injured games, upcoming opponents and a small current-season sample, the same seasons were replayed at a twentieth, a tenth, a quarter and half of the way in. Rank correlation is among players who changed teams:

| Idea | NBA: pool / top / changed teams | WNBA: pool / top / changed teams | Decision |
| --- | --- | --- | --- |
| As before | 0.746 / 0.645 / 0.730 | 0.719 / 0.714 / 0.727 | |
| A past season's minutes × 0.25 when on another team | 0.747 / 0.652 / 0.747 | 0.719 / 0.708 / 0.735 | Built (`fantasy_team_change`) |
| The same for per-minute production too | 0.740 / 0.652 / 0.730 | 0.715 / 0.704 / 0.689 | No: production carries over between teams |
| The current season counted × 1.5 | 0.746 / 0.628 / 0.737 | 0.721 / 0.718 / 0.726 | No: fewer of the top tier |
| Games under half a player's usual minutes dropped (often injury exits, 9% of games) | 0.769 vs 0.774 | 0.752 vs 0.748 | No |

A player's game-to-game swing is about 2.5 in value per game. The opponent's defensive rating and the expected pace explain 0.2% to 1.4% of it. One standard deviation of opponent defence is worth about 0.21 per game in the NBA and 0.14 in the WNBA, and pace about 0.08 and 0.06. That is small, but it tells a streamer two otherwise equal players apart, so `mart_schedule_upcoming` carries a matchup value per side (`fantasy_matchup`). Early in a season, last season's team defence predicted a game better than the first games did, so team ratings blend this season to date with last season counting as 10 games. A reworked roster takes over as its games accumulate. A player's past results against a given opponent correlated 0.00 to 0.04 with the next meeting, which is noise, so they are not used. Board and streamers show a new-team badge with the previous team.

## The board's value spread (2026-10-30)

Issue #193: the board backtest notebook regressed realised season value on the board's predicted season value. The slope was 0.55 in the NBA and 0.82 in the WNBA, which read as NBA values spread too wide. The replay (`notebooks/replay.py`) was taken apart and candidate fixes were replayed at the notebook's checkpoints. Out of sample means NBA 2023-24, a tenth, a quarter and half way in; the data holds no earlier NBA season. For the WNBA it means 2018 to 2020. In sample means the seasons the settings were chosen on. Intervals are 95% player-bootstrap intervals, 200 replicates, as in the notebook.

**Most of the gap is in the measure.** The board leaves a value below replacement unscaled by games, since a missed game from a player not worth rostering costs nothing. The target counted a missed game as zero for everyone. A below-replacement player who played half the remaining games therefore had the realised value halved. About 450 NBA players are listed at a checkpoint for a 156-player pool (about 145 WNBA players for 100), so 64% of NBA listings are below replacement, against 27% in the WNBA. Those players went on to play 58% (NBA) and 60% (WNBA) of their team's remaining games. Slopes of realised on predicted, over all seasons:

| Slope | NBA | WNBA |
| --- | --- | --- |
| Season value, every listed player (the notebook's figure) | 0.55 | 0.82 |
| Season value, target scored as the board scores (below replacement not scaled by games) | 0.81 | 0.87 |
| The same, without players who played under 30% of the rest of the season | 0.79 | 0.90 |
| Season value, players the board values above replacement | 0.79 | 0.88 |
| Value per game, players with enough games | 0.82 | 0.82 |
| Value per game, realised lines scored on the projection's pool and scale | 0.93 | 1.17 |
| Minutes per game | 0.88 | 1.00 |
| Games share | 0.75 | 1.92 |

Injured stars are not the cause: without the players who missed most of the season the NBA slope stays put. Per game, both leagues sit at 0.82. Most of that remainder is noise in the target. Realised lines over part of a season spread wider than projections, and scoring them over their own spread (the realised pool's means, spreads and replacement level) pulls every realised value in. Scored on the projection's pool and scale instead, the NBA lines are close to calibrated at 0.93 (0.965 out of sample). By category: points 1.00, rebounds 0.97, assists 1.02, threes 0.98, turnovers 0.95 and blocks 0.92. Steals (0.83) and the two percentages (0.86) run a little wide. The WNBA's lines are narrower than what follows (1.17). The WNBA's games-share slope is high because its predicted shares barely vary, being regressed by 60 games. NBA players on few projected minutes or short samples spread widest per game: 0.60 under 15 projected minutes against 0.83 over 28. Nearly all of them are below replacement.

**Fixes replayed, out of sample.** Top-N hits, Spearman and capture are against season value, missed games as zero:

| NBA 2023-24 | Slope above replacement | Slope per game | MAE per game | Top-50 hits | Spearman | Capture |
| --- | --- | --- | --- | --- | --- | --- |
| As built | 0.83 (0.72 to 0.91) | 0.83 (0.78 to 0.87) | 1.81 (1.72 to 1.89) | 0.680 (0.613 to 0.767) | 0.683 (0.637 to 0.735) | 0.855 (0.818 to 0.904) |
| Prior of 10 games, minutes and production | 0.77 (0.67 to 0.84) | 0.77 (0.72 to 0.81) | 1.95 (1.86 to 2.04) | 0.660 (0.580 to 0.740) | 0.686 (0.642 to 0.740) | 0.835 (0.778 to 0.878) |
| Per-minute prior, 300 minutes of the replacement line | 0.73 (0.65 to 0.80) | 0.68 (0.65 to 0.72) | 2.05 (1.96 to 2.16) | 0.667 (0.593 to 0.740) | 0.691 (0.646 to 0.747) | 0.841 (0.790 to 0.883) |
| Per-minute prior, 600 minutes of the pool average | 0.62 (0.54 to 0.69) | 0.53 (0.50 to 0.57) | 2.80 (2.62 to 2.97) | 0.667 (0.600 to 0.740) | 0.690 (0.644 to 0.745) | 0.848 (0.812 to 0.899) |
| Minutes prior of 10 games | 0.86 (0.76 to 0.96) | 0.86 (0.81 to 0.91) | 1.89 (1.81 to 1.98) | 0.660 (0.593 to 0.747) | 0.669 (0.624 to 0.721) | 0.840 (0.800 to 0.888) |
| Durability 40 games | 0.85 (0.74 to 0.94) | 0.83 (0.78 to 0.87) | 1.81 (1.72 to 1.89) | 0.680 (0.600 to 0.767) | 0.683 (0.638 to 0.736) | 0.857 (0.813 to 0.907) |
| Recency 1, 0.5, 0.25 | 0.83 (0.72 to 0.91) | 0.83 (0.78 to 0.87) | 1.81 (1.72 to 1.89) | 0.680 (0.613 to 0.767) | 0.683 (0.637 to 0.735) | 0.855 (0.818 to 0.904) |
| Value per game x 0.82 | 1.01 (0.88 to 1.11) | 1.01 (0.95 to 1.07) | 1.76 (1.67 to 1.84) | 0.680 (0.613 to 0.767) | 0.683 (0.637 to 0.735) | 0.855 (0.818 to 0.904) |
| Each category x its own slope | 0.98 (0.85 to 1.07) | 1.00 (0.94 to 1.05) | 1.75 (1.66 to 1.83) | 0.680 (0.620 to 0.773) | 0.685 (0.639 to 0.735) | 0.853 (0.814 to 0.901) |

| WNBA 2018 to 2020 | Slope above replacement | Slope per game | MAE per game | Top-30 hits | Spearman | Capture |
| --- | --- | --- | --- | --- | --- | --- |
| As built | 0.83 (0.75 to 0.91) | 0.79 (0.73 to 0.86) | 2.18 (2.06 to 2.32) | 0.624 (0.554 to 0.703) | 0.679 (0.645 to 0.735) | 0.814 (0.773 to 0.865) |
| Prior of 10 games, minutes and production | 0.81 (0.74 to 0.89) | 0.77 (0.71 to 0.84) | 2.20 (2.06 to 2.34) | 0.630 (0.567 to 0.703) | 0.682 (0.647 to 0.738) | 0.819 (0.783 to 0.867) |
| Per-minute prior, 300 minutes of the replacement line | 0.73 (0.66 to 0.80) | 0.68 (0.62 to 0.74) | 2.34 (2.18 to 2.51) | 0.627 (0.567 to 0.703) | 0.689 (0.658 to 0.739) | 0.815 (0.779 to 0.865) |
| Per-minute prior, 600 minutes of the pool average | 0.68 (0.61 to 0.76) | 0.61 (0.56 to 0.67) | 2.64 (2.44 to 2.82) | 0.603 (0.527 to 0.676) | 0.684 (0.649 to 0.732) | 0.798 (0.749 to 0.845) |
| Minutes prior of 10 games | 0.85 (0.76 to 0.93) | 0.80 (0.74 to 0.87) | 2.21 (2.08 to 2.34) | 0.633 (0.570 to 0.718) | 0.674 (0.638 to 0.732) | 0.819 (0.782 to 0.869) |
| Durability 120 games | 0.84 (0.76 to 0.93) | 0.79 (0.73 to 0.86) | 2.18 (2.06 to 2.32) | 0.633 (0.573 to 0.715) | 0.679 (0.645 to 0.736) | 0.819 (0.783 to 0.871) |
| Value per game x 0.83 | 1.00 (0.90 to 1.09) | 0.95 (0.87 to 1.03) | 2.16 (2.01 to 2.28) | 0.624 (0.554 to 0.703) | 0.679 (0.645 to 0.735) | 0.814 (0.773 to 0.865) |
| Each category x its own slope | 1.04 (0.94 to 1.13) | 0.98 (0.90 to 1.07) | 2.14 (1.99 to 2.26) | 0.627 (0.557 to 0.703) | 0.684 (0.653 to 0.743) | 0.816 (0.779 to 0.867) |

In sample, slope above replacement / MAE per game / top-N hits / capture:

| Change | NBA 2024-25 and 2025-26 | WNBA 2021 to 2026 |
| --- | --- | --- |
| As built | 0.78 / 1.66 / 0.620 / 0.802 | 0.90 / 2.00 / 0.710 / 0.867 |
| Prior of 10 games | 0.77 / 1.74 / 0.628 / 0.810 | 0.88 / 2.02 / 0.711 / 0.872 |
| Per-minute prior, 300 minutes of the replacement line | 0.73 / 1.77 / 0.625 / 0.810 | 0.82 / 2.12 / 0.711 / 0.871 |
| Per-minute prior, 600 minutes of the pool average | 0.68 / 2.06 / 0.635 / 0.817 | 0.80 / 2.38 / 0.706 / 0.864 |
| Minutes prior of 10 games | 0.81 / 1.69 / 0.620 / 0.801 | 0.91 / 2.01 / 0.708 / 0.868 |
| Durability 40 NBA, 120 WNBA | 0.79 / 1.66 / 0.630 / 0.811 | 0.92 / 2.00 / 0.710 / 0.867 |
| Recency 1, 0.5, 0.25 (NBA) | 0.78 / 1.65 / 0.637 / 0.816 | |
| Value per game x 0.82 NBA, x 0.83 WNBA | 0.95 / 1.60 / 0.620 / 0.802 | 1.08 / 1.93 / 0.710 / 0.867 |
| Each category x its own slope | 0.93 / 1.60 / 0.625 / 0.804 | 1.11 / 1.93 / 0.715 / 0.872 |

**Nothing changes in the model.**

- Shrinking per-minute production, toward the replacement line or the pool average, or a larger prior, widens the spread instead of narrowing it. The board standardises over the projected pool, so pulling every line in also pulls in the pool's spread. Pulling short samples in harder than long ones then leaves the established players further apart in z. Every such prior lowered the slope and raised the error in both leagues, with hit rates flat or lower.
- A minutes prior raised the slope a little but cost rank correlation (NBA out of sample −0.013, 95% interval −0.022 to −0.005).
- Durability and NBA recency moved nothing outside the noise out of sample. NBA recency cannot act on 2023-24, which has no earlier season, and it helped only in sample, on the seasons it would be chosen on.
- A common factor, ×0.82 NBA and ×0.83 WNBA (fitted in sample), brings both slopes to 1 and lowers the error per game (NBA out of sample −0.055, −0.106 to −0.008). It changes no rank, tier or hit: tiers are natural breaks, which a common factor does not move. That makes it a change of unit, not of the board. The factor is the same in both leagues, so it does not describe an NBA problem. It is the pull any projection shows against a noisy part-season scored over its own spread. And the board publishes its projected z columns beside the season, last-20 and last-10 z columns, all z-scores over a pool, which a factor on one set would put in different units.
- Weighting each category by its own slope (steals 0.68 to points 0.90 in the NBA) moved ranks only within the noise.

Values stay z-scores of the projected lines over the projected pool. The notebook now reports the slope like for like: over the players the board values above replacement, and per game over players with enough games. On the current data that is 0.79 and 0.82 for the NBA, and 0.88 and 0.82 for the WNBA.

## No aging curve before the season (2026-10-30)

Before a season the projection rests on the last three seasons and says nothing of age. A player's minutes and per-minute production change from one season to the next with age. The question was whether a curve of that change makes the preseason board better.

The curve is the year-over-year change in minutes per game and in per-minute production, by age at the next season's first game. Production is an equal mix of points, rebounds, assists, steals, blocks and threes, each against the league's rate. The pairs are players with 200 minutes (NBA) or 100 (WNBA) in both seasons, weighted by the harmonic mean of the two seasons' minutes. The fit is a quadratic in age, clipped to 20 to 36. Age comes from the roster birth date in `dim_player` ('MAR 03, 1996', parsed as `stats_birth_date` does), and every player with minutes has one but for about 1% of minutes. Weighted changes over every pair:

| Age at the next season | NBA pairs | NBA minutes / production | WNBA pairs | WNBA minutes / production |
| --- | --- | --- | --- | --- |
| Under 23 | 119 | +7.2% / +5.5% | 32 | +2.1% / +1.9% |
| 23 to 26 | 216 | +2.6% / +2.6% | 238 | +8.5% / +3.6% |
| 26 to 29 | 175 | −0.1% / +0.4% | 230 | +0.4% / +0.3% |
| 29 to 32 | 115 | −4.8% / −0.0% | 173 | −1.3% / +0.3% |
| 32 and over | 101 | −8.1% / −0.7% | 151 | −5.3% / −0.8% |

Age moves minutes far more than per-minute production. The preseason projection's minutes and production were multiplied by the fitted curve, scored again and compared with the rest of the season at the board backtest's preseason checkpoint. *Forward* fits the curve on the transitions before the season tested. The NBA history holds two transitions, so it has one forward season: 2025-26, from a curve fitted on 2023-24 to 2024-25. *Cross-fitted* also uses later transitions, which adds NBA 2024-25 but is not a forward test. Both curves together, with 95% player-bootstrap intervals on the change:

| Preseason | Top-N hits, season value | Top-N hits, per game | Rank correlation, season value | Error per game | Capture | Slope above replacement |
| --- | --- | --- | --- | --- | --- | --- |
| NBA 2025-26, forward | 0.560 to 0.640 (+0.080, +0.019 to +0.180) | 0.640 to 0.740 (+0.100, +0.040 to +0.200) | 0.598 to 0.608 (+0.011, −0.007 to +0.025) | 2.095 to 2.016 (−0.079, −0.140 to −0.031) | 0.791 to 0.833 (+0.042, −0.021 to +0.099) | 0.87 to 0.96 |
| NBA 2024-25 and 2025-26, cross-fitted | 0.610 to 0.640 (+0.030, −0.010 to +0.080) | 0.680 to 0.730 (+0.050, +0.010 to +0.120) | 0.658 to 0.668 (+0.010, −0.001 to +0.019) | 1.930 to 1.869 (−0.062, −0.093 to −0.018) | 0.808 to 0.825 (+0.016, −0.042 to +0.052) | 0.81 to 0.86 |
| WNBA 2025 and 2026, forward | 0.633 to 0.633 (+0.000, −0.034 to +0.067) | 0.650 to 0.650 (+0.000, −0.050 to +0.050) | 0.637 to 0.634 (−0.003, −0.017 to +0.011) | 2.460 to 2.422 (−0.038, −0.084 to +0.002) | 0.805 to 0.798 (−0.007, −0.030 to +0.030) | 0.80 to 0.80 |
| WNBA 2020 to 2026, forward | 0.652 to 0.648 (−0.005, −0.033 to +0.024) | 0.690 to 0.676 (−0.014, −0.052 to +0.010) | 0.638 to 0.632 (−0.006, −0.013 to +0.001) | 2.395 to 2.389 (−0.007, −0.038 to +0.030) | 0.814 to 0.804 (−0.010, −0.030 to +0.009) | 0.77 to 0.79 |

The minutes curve alone and the production curve alone show the same pattern. The slope of realised on predicted value above replacement moved toward 1 in the NBA and barely moved in the WNBA. **The board does not age players.**
- The WNBA has the power: eight transitions of about 100 pairs and seven forward seasons. There the curve raised no hit rate or rank correlation, and the only intervals clear of zero were small losses (the production curve, per-game top 30, −0.010).
- The NBA gain rests on one forward season. Four more of the top 50 is four players at one checkpoint. Cross-fitted 2024-25 lost one, and a player bootstrap of a single season resamples players, not seasons.
- Rank correlation rose by about 0.01 and the error per game fell in both NBA seasons. A change of scale also lowers that error (the value spread addendum), so it is not evidence of a better ranking on its own.

The board backtest notebook keeps the test. It is worth another look once NBA 2026-27 is complete, which gives a second forward NBA season. The curve would be adopted only if its top-N and rank-correlation gains then hold in both forward seasons.

## In-season minutes follow the last five games (2026-10-30)

Issue #124 asked whether recent role signals predict a player's minutes better than the season-weighted figure the projection used. The test was a replay of every season at a checkpoint every 14 days. For every player with 5+ games so far, it predicted his mean minutes over his next 10 games played. Signals were fitted on the earlier seasons and tested on the latest: NBA 2025-26, WNBA 2025 and 2026.

| Minutes per game | NBA error | WNBA error | Players whose role just moved (5+ minutes), NBA / WNBA |
| --- | --- | --- | --- |
| Season-weighted (as was) | 3.98 | 3.92 | 5.70 / 5.02 |
| Half season-weighted, half the last five games | **3.44** | **3.30** | **4.25 / 3.73** |
| A fitted blend with recent starts | 3.45 | 3.22 | 4.21 / 3.72 |
| The fitted blend plus teammates' vacated minutes | 3.44 | 3.22 | 4.18 / 3.72 |

The last five games carry nearly all of the gain, and a plain half-and-half blend does as well as a fitted one. Recent starts add little beyond it. The minutes of teammates who sat out the latest game add nothing; their absence shows up in the last five games anyway.

So, in season, with five or more games for his current team, a player's projected minutes are half the season-weighted figure and half his last five games (var `fantasy_recent_minutes`, 0.5). Per-minute production is unchanged. Out of season the projection is as before, because the replay tested in-season horizons only. The play-by-play that motivated the question stays a daily fetch for the lineups and the shot data; its lineup model can feed a later on/off study.

## Minutes after a return from absence (2026-10-30)

The in-season blend follows a player's last five games. For a player who is still out, or has just come back, those five are the games before the absence, so the projection expects their old minutes at once. The replay of the in-season minutes addendum was run again with each player's absences. An absence is a run of three or more consecutive games of the player's current team that the player did not play (a did-not-play row in `fct_player_game`, or no row). The team's games count from the player's first game for it this season, or from its first game when it was the player's main team last season, so an injury carried over from last season counts. The protocol is the addendum's: a checkpoint every 14 days, every player with five or more games so far, and as target the mean minutes of the next 5 and the next 10 games played (at least 5). The rule was chosen on NBA 2023-24 and 2024-25 and WNBA 2018 to 2024, and tested on NBA 2025-26 and WNBA 2025 and 2026. Bias is actual minus projected minutes, as built:

| Status at the checkpoint, next 5 / next 10 games | NBA, chosen on | NBA 2025-26 | WNBA, chosen on | WNBA 2025 and 2026 |
| --- | --- | --- | --- | --- |
| Still out after 3+ games missed | −1.71 / −0.87 | −2.22 / −1.61 | −1.86 / −1.32 | −1.85 / −1.07 |
| One game back | −0.57 / +0.20 | −0.36 / +0.30 | +0.58 / +0.54 | −0.95 / −0.21 |
| Two to five games back | +0.01 / +0.44 | +0.04 / +0.54 | +0.43 / +0.57 | +0.41 / +0.82 |
| No absence, or six or more games back | −0.05 / +0.07 | −0.10 / −0.06 | +0.90 / +0.96 | +0.33 / +0.39 |

The shortfall is in the first games back, and it grows with the absence. Up to five games back in NBA 2025-26, the next five games fell short by 0.53 minutes after 3 to 5 games missed, 1.41 after 6 to 10 and 2.00 after 11 to 20. Two games back the last five already hold the shorter games, and the bias is gone.

**The rule.** One rule for both leagues was searched on the seasons it was chosen on, by the mean of the next-5 and next-10 errors. The grid covered:
- the shortest absence: 1, 2, 3, 5 or 8 games;
- how many games back the cut lasts: 1, 2, 3 or 5;
- the cut per game missed: 0.5% to 2%;
- the most it can cut: 15%, 25%, 50% or no limit.

The best was 1% per game missed, fading over two games back. A cap of 50% and no cap tied, since only an absence of more than 50 games reaches it. Shortest absences of one to three games scored within 0.002 minutes of each other. Three games leaves a rest day or two alone, so the rule takes three.

So in season, for a player with five or more games this season, projected minutes are cut by 1% for each game of the latest absence of three or more games (at most 50%) while the player is still out. After the first game back half the cut applies, and from the second none (var `fantasy_return_ramp`). Per-minute production is unchanged, so the whole projected line scales with the minutes. Error for the players cut, with 95% player-bootstrap intervals on the change:

| Players cut | Checkpoints | Players | Next 5 games | Next 10 games | Everyone, next 5 / next 10 |
| --- | --- | --- | --- | --- | --- |
| NBA 2025-26 (out of sample) | 11 | 703 | 4.57 to 4.13 (−0.45, −0.61 to −0.24) | 4.24 to 3.94 (−0.30, −0.50 to −0.06) | 3.55 to 3.48 / 3.34 to 3.29 |
| NBA 2023-24 and 2024-25 (chosen on) | 22 | 1,527 | 4.38 to 4.03 (−0.35, −0.50 to −0.17) | 4.25 to 4.05 (−0.21, −0.36 to −0.02) | 3.56 to 3.50 / 3.37 to 3.34 |
| WNBA 2025 and 2026 (out of sample) | 16 | 178 | 4.16 to 3.94 (−0.22, −0.53 to +0.06) | 4.06 to 4.04 (−0.02, −0.30 to +0.30) | 3.43 to 3.41 / 3.26 to 3.25 |
| WNBA 2018 to 2024 (chosen on) | 42 | 247 | 4.48 to 4.36 (−0.12, −0.38 to +0.14) | 4.27 to 4.20 (−0.07, −0.33 to +0.17) | 3.68 to 3.68 / 3.55 to 3.55 |

Nobody else's projection moves. Out of sample the cut takes the bias of the players still out from −2.22 to −0.57 (next 5) and from −1.61 to +0.04 (next 10) in the NBA, and from −1.85 to −0.75 and −1.07 to +0.03 in the WNBA. The half cut one game back helps the next five games but overshoots the next ten a little (NBA +0.30 to +0.86). So does the cut after the longest absences: the 61 NBA 2025-26 players back within five games of 21 or more missed went from −1.88 to +1.44 over the next five, against −3.27 to +0.42 on the seasons the rule was chosen on. The WNBA has far fewer long absences, 178 players cut over two seasons, so its intervals include zero; the direction agrees and nothing gets worse, so it takes the same rule rather than one fitted to its own noise.

The rest-of-season board barely moves. At the in-season checkpoints, with and without the cut, top-N hits, rank correlation, error per game and capture changed by at most 0.006, in and out of sample. About 56 NBA and 6 WNBA players are cut at a checkpoint. The cut is a short-horizon correction for the next few games, which is what Streamers and a weekly lineup read.

`mart_player_projection` publishes `absence_games`, `games_since_return` and `return_minutes_factor`. The replay applies the same rule, a dbt unit test pins it on a ten-game team (the cap, the fade, an absence too short to count, one carried over from last season, a player who joined mid-season and one with under five games), and `assert_projected_minutes_blend` now takes the cut out before checking the blend. The board backtest notebook re-tested the rule on every build until it was retired with the replay (#776); the walk-forward harness judges the board as built, the rule included (ADR 0018).

## Addendum (2026-11-02): when the aging curve is tested again

The section on the aging curve waits for a second forward NBA season. That is NBA 2026-27, whose regular season ends in April 2027: the board backtest notebook runs the test again on the first full build after it, and the curve is adopted only if its top-N and rank-correlation gains hold in both forward seasons (#492).
