# 0003. Gold modelling choices

Date: 2026-10-27
Status: Accepted

## Context

Phase 3 turns the typed silver layer into the star schema and fantasy marts the app, notebooks and BI read, and adds the quality checks that gate publishing. A few choices were not dictated by the spec and are recorded here so they are not relitigated.

## Decisions

**Player stints come from appearances, not from the player directory.** `dim_player` is SCD type 2 on team. The directory (`commonallplayers`) only knows a player's current team, and daily snapshots exist only from the day ingestion started, so team history for the backfilled seasons has to come from where the player actually played: a stint starts at the first game with a new team and ends the day before the next team's first game. Names, position and biography come from the directory and rosters. The ESPN id column waits for the phase 4 crosswalk.

**Box score closure excludes turnovers.** On real data every counting stat sums from player rows to the team row exactly, except turnovers: the team figure includes team turnovers (shot-clock, 8-second and inbound violations) that belong to no player. The error-severity closure check covers every other stat; a warn-severity check asserts the team figure is at least the players' sum and not more than eight above it.

**Pool for z-scores is by total minutes.** The spec fixes the pool size (top 180 NBA, top 90 WNBA) but not the ranking; total minutes in the window is the least surprising proxy for "fantasy-relevant player" and does not depend on the categories being scored. Percentages use a volume-weighted impact ((player pct - pool pct) x attempts per game) standardised over the pool, never a plain average.

**Blend weights hand missing seasons to the others.** Current 0.30 rising linearly to 0.80 at 20 games; last season 0.55 and the season before 0.15 share what remains in that ratio; a missing season gives its weight to the rest so a rookie is scored on current-season data alone. *Superseded by the board value addendum below.*

**Fixture sample is a shape fixture.** The sample built from recorded fixtures has a few rows per payload and is not a coherent season, so the data-quality checks (`tag:quality`) run only against real data in the nightly build; CI runs the structural tests (keys, relationships, accepted values) and the gate on the sample.

**Lineups and tracking facts are deferred.** `fct_event` reserves lineup columns; deriving the five on the floor needs substitution tracking across periods and is its own piece of work. `fct_player_tracking_season` needs the tracking endpoints, which are not ingested yet. Both are listed for phase 5 or 6 alongside the surfaces that would show them.

## Consequences

- `dim_player.valid_from` is a game date, so a player traded between games is attributed to the new team from their first game there.
- Team turnovers are visible as the difference between `fct_team_game.turnovers` and the players' sum.
- Completeness is checked against the schedule, so the gate stays blocked until the full backfill has landed; that is the intended signal, not noise.

## Addendum (2026-10-29): availability, rest of season and lineups

**Availability.** ESPN's injury feed names the athlete but carries no athlete id, so `fct_availability` links each listing by name within the team: through the ESPN roster to the athlete id and the player crosswalk, or straight to the league player currently on that team. `is_current` marks the latest report. The board turns the report into an availability multiplier: the share of the team's remaining regular-season games the player is expected to play (out: the games before the expected return, or all of them without a date; doubtful 0.75 of a game, questionable 0.5, day-to-day 0.25).

**Rest of season** counts regular-season games only, the ones fantasy leagues score. Once a league's regular season is over (playoffs or the off-season) the board marks `season_complete` and the rest-of-season value equals the blend, instead of scaling everyone to zero.

**Lineups.** `silver.event_lineups` gives every play-by-play action the five players on the floor per side. The feed's substitution names only the player leaving by id; the player coming on is matched against the game's box score by a ranked set of name rules: surname with any given-name prefix the feed adds to tell teammates apart ("K. Mitchell", "Jal. Williams"), suffix kept so "Carter Jr." is not his teammate Carter; then surname without the suffix; then the first part of a hyphenated surname, for names that changed since (the box score says "Laney-Hamilton", a 2019 substitution says "Laney"); then given name, for names the feed writes in the other order; then the last word of a longer name. A dbt unit test pins each rule. Events are ordered by game clock within the period, because the feed logs some substitutions late and action numbers are not chronological. Period starters come from the box score in the first period and are inferred afterwards (a first substitution out, or an action before any substitution in). Over the full history every season has five a side on at least 93.5% of actions: 98.6% to 99.3% for each NBA season, 99.1% or better for WNBA 2020 to 2026, and 93.5% and 94.8% for WNBA 2018 and 2019, whose feed misses more substitutions. A warn check flags any season under 90%.

## Addendum (2026-10-29): board value

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

## Addendum (2026-10-29): the league, rosters and tiers

**The league lives on its own page.** The `/league/` page holds the manager's league: its size, scoring and point weights, its teams in draft order, and each team's roster. Players are added by search or by pasting a roster as any fantasy host lists it; names are matched without accents, punctuation or suffixes. A snake draft runs there or on the board, with undo. The board, Streamers and the League page all read one record per league, kept in the browser (`fantasyscout:league:<league>`), and a change in one tab reaches the others. A league file moves it between browsers. Nothing is sent to a server, so the gold layer stays the same for everyone and the league-specific arithmetic (replacement level, tiers, Fit) runs on the client against the published board.

**Tiers are measured in the league's picks.** The earlier tiers started wherever one player's value fell well below the next one's. They had no meaning in a manager's league, and their number depended on noise near the top. Now the players a league this size rosters (teams × roster spots) are split into one group per roster spot, at the cuts that minimise squared deviation within the groups. That is the exact one-dimensional optimum (Jenks natural breaks), found by dynamic programming in O(k·n²), which takes a few milliseconds for 156 players and 13 tiers. Each tier is labelled with:
- its picks and the draft rounds they fall in;
- its range of values;
- once rosters are in, how many of its players are still available.

Players outside the pool form a waiver group. The top of the distribution is steep, so its tiers are small: the elite players are separated one by one, while the flatter middle forms tiers about one round wide.

## Addendum (2026-10-29): betting lines

ESPN's scoreboards carry the sportsbook line for upcoming games, and its game summaries carry the closing line for finished ones, in both leagues. Both were landed and discarded until now. `silver.game_lines` keeps one line per game: the home spread, the over/under, and each side's implied points, (total ∓ spread) / 2. The closing line wins over earlier scoreboards. The daily ESPN run now also lands the next seven days' scoreboards, so upcoming games have their current line.

`mart_schedule_upcoming` carries the line beside the matchup value. Streamers shows each team's implied points in the week grid and as a Team pts column. The line does not change the matchup value or the window value yet. The closing lines on past summaries make the backtest possible: whether implied team points predict a player's production beyond the defence-and-pace matchup. It runs before the line moves any score.

## Addendum (2026-10-29): the leagues' official injury reports

The NBA publishes an official injury report every 15 minutes on game days, and the WNBA publishes reports on the same host. Teams file by 5 pm the day before a game. A report lists every player's status for the next game (Out, Doubtful, Questionable, Probable, Available) with the league's reason, G League assignments and two-way players included, and marks a team that has not filed yet.

The ingest lands the newest report as parsed JSON (`ingest/injury_report.py`, which parses the PDF from word positions). It lands one in the morning run and one in an evening run at 7 pm ET, after teams file and before tip-off. `silver.official_injury_report` types it, and `gold.fct_player_status` gives each player one current status. The official report wins for the next game it covers; otherwise ESPN's listing applies.

The official status speaks only to the next game, so the board shows it but the rest-of-season availability multiplier keeps reading ESPN's listing and expected return. A one-game "Rest" or G League "Out" does not erase a season's value. Official rows link to players by name within the team. `warn_official_injury_links` reports more than five unlinked players on the newest report.

## Addendum (2026-10-30): ESPN's headlines on the player page

ESPN's news feed lists each league's latest 50 articles, each tagged with the athletes it is about. The reports run lands the feed twice a day, under the Eastern date and hour (`ingest/espn_news.py`), so headlines accumulate even though the feed itself only reaches back a day or two in season. Only the headline, its date, ESPN's link and the tagged athlete ids land: never the story, the images or the byline. The site shows a headline, its date and a link to the story on ESPN, and credits ESPN.

`silver.player_news` links each tagged athlete through the player crosswalk and sorts the headline by its wording into one flag: out for season, surgery, minutes limit, return, injury, G League or role (first match wins, none when nothing applies). `gold.fct_player_news` keeps articles tagged with the player and at most three others, since a roundup that tags eight players says little about any one of them. Each player's file carries the newest eight.

The flags are labels for the reader, not inputs to the projection. A headline flag is a weaker signal than the official injury report, ESPN's injury listing and the Expected and Confirmed lineups, which the board already reads. With no history of the feed there is nothing to backtest against yet. ESPN's NBA depth charts were considered as a starter prior and left out: the league's lineups already name each game's starters. Checked against the six teams with Expected lineups on 2026-10-29, four depth charts named the same five, and in the other two the lineups carried a change the depth chart had not yet made.

## Addendum (2026-10-30): waiver heat from Sleeper

Sleeper lists the NBA players its leagues added and dropped most over the last day (free for non-commercial use, with credit to Sleeper; the WNBA lists are always empty). It is a direct read of what other managers are doing on the waiver wire, which the streamers page otherwise infers from minutes and value. The reports run lands the add and drop lists, the top 50 of each over 24 hours, under the Eastern date and hour (`ingest/sleeper.py`). Sleeper's player directory lands once a day, as Sleeper asks, trimmed to the active players on a team with their name, Sleeper's ASCII search name, team and birth date.

Sleeper's directory carries no league or ESPN id, so `gold.fct_waiver_trend` links by name. Sleeper's search name ("kristapsporzingis", "jimmybutleriii") folds accents and keeps the suffix, so it is compared with the league name with its suffix kept; both names without suffixes also count. A matching birth date, then a matching team, picks between namesakes, and a name that still matches more than one current player stays unlinked. Against the live board on 2026-10-29, 98 of the 100 trending players matched by name, and the two that did not were free agents. `warn_sleeper_links` reports more than five unlinked trending players on a team.

Streamers shows the net adds (added minus dropped) with both counts in the tooltip, filters to players being added, and credits Sleeper. Like the market columns, the heat informs a pick and does not move the value.

## Addendum (2026-10-30): rest, travel and altitude

`gold.fct_team_game_context` gives every team-game, played or scheduled, its circumstances:
- days of rest, the second night of a back-to-back, and a third game in four nights;
- the great-circle miles from the previous game's city, and the time zones crossed;
- the venue's altitude, flagged at 4,000 feet or more (Denver, Salt Lake City, Mexico City).

Venues are placed by the arena city the league schedule gives, through a seed of latitude, longitude, elevation and standard UTC offset. The seed covers every home city and the neutral and occasional sites in the 2025 to 2027 schedules, and `warn_venue_cities` names any city it misses. A dbt unit test pins the arithmetic on a three-game road trip.

The schedule mart and Streamers show back-to-backs and travel beside the matchup value; they do not change it. Whether a back-to-back or a long trip moves a player's production enough to count is the next backtest, over the played games this table already covers.

## Addendum (2026-10-30): in-season minutes follow the last five games

Issue #124 asked whether recent role signals predict a player's minutes better than the season-weighted figure the projection used. The test was a replay of every season at a checkpoint every 14 days. For every player with 5+ games so far, it predicted his mean minutes over his next 10 games played. Signals were fitted on the earlier seasons and tested on the latest: NBA 2025-26, WNBA 2025 and 2026.

| Minutes per game | NBA error | WNBA error | Players whose role just moved (5+ minutes), NBA / WNBA |
| --- | --- | --- | --- |
| Season-weighted (as was) | 3.98 | 3.92 | 5.70 / 5.02 |
| Half season-weighted, half the last five games | **3.44** | **3.30** | **4.25 / 3.73** |
| A fitted blend with recent starts | 3.45 | 3.22 | 4.21 / 3.72 |
| The fitted blend plus teammates' vacated minutes | 3.44 | 3.22 | 4.18 / 3.72 |

The last five games carry nearly all of the gain, and a plain half-and-half blend does as well as a fitted one. Recent starts add little beyond it. The minutes of teammates who sat out the latest game add nothing; their absence shows up in the last five games anyway.

So, in season, with five or more games for his current team, a player's projected minutes are half the season-weighted figure and half his last five games (var `fantasy_recent_minutes`, 0.5). Per-minute production is unchanged. Out of season the projection is as before, because the replay tested in-season horizons only. The play-by-play that motivated the question stays a daily fetch for the lineups and the shot data; its lineup model can feed a later on/off study.

## Addendum (2026-10-30): defence by position does not earn a place in the matchup

Issue #142 asked whether an opponent's defence against a player's position explains his game beyond the opponent's overall defence, which the matchup score already uses. The test was every player-game with 10+ minutes after a player's first five games. The measure was his fantasy points per minute (ESPN's default points) against his season average to date. Two signals were taken from what the opponent had allowed before that day: per minute to all players, and per minute to players of his primary position (G, F or C), less the overall figure. Both were standardised over the league's teams. The signals were fitted on earlier seasons (NBA 2023-24 and 2024-25, WNBA 2021 to 2024) and tested on the latest (NBA 2025-26, WNBA 2025 and 2026).

| Signal | NBA, out-of-sample share of the game-to-game swing explained | WNBA |
| --- | --- | --- |
| Overall defence | 2.25% | 1.77% |
| Overall plus defence by position | 2.26% | 1.81% |
| Defence by position alone | −0.04% | 0.02% |

One standard deviation of overall defence is worth about 1.8 fantasy points over 30 minutes in the NBA and 1.5 in the WNBA. Positional defence is worth 0.15 and 0.31, an order of magnitude less and inside the noise. Positional defence tables are mostly a sample of who happened to play against whom. So the matchup score keeps overall defence and pace, and nothing is built for positions. The stats API's defender tracking (leaguedashptdefend, boxscorematchupsv3) measures defenders rather than opponents' positions. Each needs per-game calls on the home runner, and with this result it is not worth that cost now.

## Addendum (2026-10-30): a ledger for the signals that have no history yet

The newer inputs (official injury reports, lineups, the ESPN market, Sleeper, headline flags) have only days of history, and the published builds that carry them roll off after seven builds. None of them can be backtested unless the board's view is kept. `gold.fct_board_history` keeps it: one row per Eastern date, league and player with the projection, the value, availability, lineup role, market rank and ownership bucket, stakes, and the streamer signals. Every build merges the day's rows and a later build the same day replaces them. The model sets `full_refresh=false`, so a full refresh never rebuilds it and the history only grows (about 1,100 rows a day). `gold.fct_game_line` publishes the closing line for every played game, which the context analyses need.

`ops.feed_freshness` gives each feed's newest landing day and its age against the age the feed may reach while the league is playing. A feed that stops keeps its last snapshot in silver and gold, where it would otherwise look current. `warn_stale_feeds` flags a stale feed, or a feed that has never landed in season, and Data Health lists every feed.

## Addendum (2026-10-30): Streamers sort by what a player adds to the week

The streamer signals notebook replays Streamers every Monday of each regular season. It ranks the players outside the rostered pool by each signal and scores them on what they add to the next seven days' category totals; a game not played adds nothing. On the latest season it compared each sort's top ten with the week's ten best pickups. The default sort, the minutes trend, found 1.9 of them in the WNBA and 0.9 in the NBA. Last-ten production times the team's games found 3.3 and 1.4. The page's Window value multiplied the last-ten z-score by games, and a z-score is measured from the pool's average: more games make a below-average player look worse. It ranked near zero in the WNBA.

`mart_streamers.last_10_production` is what an average game of the last ten adds to the category totals, in units of each category's spread over the season's pool. Counting stats add, turnovers subtract, and shooting adds its makes above the pool's percentage. It is the last-ten z-score plus a constant, so it ranks players the same way, but it stays positive for about 95% of them and so scales with games. Window value is now production times games in the window, plus each game's matchup. It is the default sort while games are scheduled. An 8-category league leaves the turnovers term out.

## Addendum (2026-10-30): availability calibrated on past official injury listings

The board's rest-of-season value scales by an availability multiplier: the share of the remaining regular-season games the player is expected to play. It charged fixed amounts per ESPN status:
- out with a return date: the games before it;
- out without a date: every game left;
- doubtful: 0.75 of a game;
- questionable: 0.5;
- day-to-day: 0.25.

The game context notebook found that players who miss a game go on to miss 3 to 5 more on average, so these charges were never checked against outcomes.

The leagues keep every official injury report on their host, the NBA's back to 2023-24, and `fs-ingest land reports --history` lands the 5 pm Eastern report for each past day. `gold.fct_official_listing` links each listing before a regular-season game to the game and the player, and counts the team's games until the player next played. NBA 2024-25, injury listings only:

| Status | Listings | Missed the game | Games missed, mean | Median | Old charge |
|---|---|---|---|---|---|
| Out | 5,635 | 100% | 12.6 | 7 | every game left, if no return date |
| Doubtful | 169 | 98% | 4.7 | 2 | 0.75 |
| Questionable | 1,512 | 50% | 1.6 | 1 | 0.5 (day-to-day 0.25) |
| Probable | 548 | 6% | 0.2 | 0 | 0 |

The fixed charges were off in both directions. Doubtful and questionable listings were undercharged several times over. An out listing without a date erased the whole season, where the typical absence is about two weeks.

The multiplier now charges a listed player the average, over past injury listings with the same status, of the games then missed, capped at the games the team has left. Rules:
- **Status:** the official report's status for the next game, else ESPN's listing in the report's words (day-to-day reads as questionable).
- **Return date:** ESPN's expected return date, when given for a player ruled out, still counts the games before it.
- **Out for the season:** an ESPN note that the player is out for the season counts every game.
- **Which league's history:** a league uses its own listings once it has 300 for the status. Until then the NBA's apply; the WNBA archive only starts in 2026.
- **No history:** without any listing history the old charges apply.

The averages update with every build as the daily reports add listings. The game context notebook publishes the table per league.

The calibration matches the reason as well as the status. An official Out for rest is averaged over past rest listings (NBA 2024-25: 1.2 games), not injury listings (12.6). The same holds for a G League assignment, personal reasons or a suspension. ESPN's listings are injuries.

## Addendum (2026-10-30): the board's value spread

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

## Addendum (2026-10-30): altitude is the visitor's, and time zones follow daylight saving

`at_altitude` marked both teams in a game at Denver, Salt Lake City or Mexico City. Two consequences:
- Streamers flagged the Nuggets and the Jazz "at altitude" in their own home games.
- The game context notebook's altitude estimate (+0.98 fantasy points per 30 minutes in the NBA) mixed acclimatised home teams with visitors, the case the effect is about.

`fct_team_game_context.visiting_at_altitude` now marks only the visiting team. The notebook estimates visiting at altitude, and visiting at altitude on the second night of a back-to-back. Results for NBA 2025-26, out of sample with player-bootstrap intervals:

| Visiting at altitude | Fantasy pts / 30 min | Minutes | Sat out (pts) |
| --- | --- | --- | --- |
| Any game | +0.78 (-0.25 to +1.79) | +0.36 (-0.20 to +0.98) | +2.2 (-0.5 to +5.2) |
| Extra on a back-to-back | -1.04 (-4.00 to +2.23) | -0.72 (-2.02 to +0.41) | -8.6 (-15.6 to +2.0) |

Neither effect is distinguishable from zero, so altitude stays out of the matchup value and is shown, for the visitor only, as context. No WNBA venue is at altitude.

`time_zones_crossed` used each city's standard UTC offset all year. Arizona, Mexico City, Honolulu and a few overseas venues keep standard time, so in summer Phoenix shares Los Angeles's clock, and the WNBA season is in summer. The venues seed now records `observes_dst`, and offsets follow US daylight saving on the game's date (second Sunday of March to first Sunday of November). European venues change on other Sundays, a week or two apart.


## Addendum (2026-10-30): referee crews, and whether their tendencies carry over

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

## Addendum (2026-10-30): expected games, the board's line and opportunity do not beat the Streamers sort

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

## Addendum (2026-10-30): the betting-line backtest

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
