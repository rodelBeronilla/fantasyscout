# 0003. Gold modelling choices

Date: 2026-10-27
Status: Accepted

## Context

Phase 3 turns the typed silver layer into the star schema and fantasy marts the app, notebooks and BI read, and adds the quality checks that gate publishing. A few choices were not dictated by the spec and are recorded here so they are not relitigated.

## Decisions

**Player stints come from appearances, not from the player directory.** `dim_player` is SCD type 2 on team. The directory (`commonallplayers`) only knows a player's current team, and daily snapshots exist only from the day ingestion started, so team history for the backfilled seasons has to come from where the player actually played: a stint starts at the first game with a new team and ends the day before the next team's first game. Names, position and biography come from the directory and rosters. The ESPN id column waits for the phase 4 crosswalk. _Superseded: `silver.player_xwalk` fills it (ADR 0005)._

**Box score closure excludes turnovers.** On real data every counting stat sums from player rows to the team row exactly, except turnovers: the team figure includes team turnovers (shot-clock, 8-second and inbound violations) that belong to no player. The error-severity closure check covers every other stat; a warn-severity check asserts the team figure is at least the players' sum and not more than eight above it (`vars.quality_thresholds.team_turnovers_max`). In the build of 2026-11-02, every season from NBA 2023-24 and WNBA 2018 on had 100.0% of its team-games within that range (data-quality notebook), so no team-game had more than eight team-only turnovers.

**Pool for z-scores is by total minutes.** *(Superseded by [ADR 0019](0019-one-value-scale.md): every window is now scored on the fantasy league's own pool, above replacement level, regular season only.)* The spec fixes the pool size (top 180 NBA, top 90 WNBA) but not the ranking; total minutes in the window is the least surprising proxy for "fantasy-relevant player" and does not depend on the categories being scored. Percentages use a volume-weighted impact ((player pct - pool pct) x attempts per game) standardised over the pool, never a plain average.

**Blend weights hand missing seasons to the others.** Current 0.30 rising linearly to 0.80 at 20 games; last season 0.55 and the season before 0.15 share what remains in that ratio; a missing season gives its weight to the rest so a rookie is scored on current-season data alone. *Superseded by the board value addendum, which moved to [ADR 0009](0009-board-value.md) on 2026-11-01.*

**Fixture sample is a shape fixture.** The sample built from recorded fixtures has a few rows per payload and is not a coherent season, so the data-quality checks (`tag:quality`) run only against real data in the nightly build; CI runs the structural tests (keys, relationships, accepted values) and the gate on the sample.

**Lineups and tracking facts are deferred.** _Superseded: `silver.event_lineups` and `fct_event`'s lineups shipped 2026-10-29 (the lineups addendum below), `fct_player_tracking` on 2026-10-30 (ADR 0004 addendum)._ `fct_event` reserves lineup columns; deriving the five on the floor needs substitution tracking across periods and is its own piece of work. `fct_player_tracking_season` needs the tracking endpoints, which are not ingested yet. Both are listed for phase 5 or 6 alongside the surfaces that would show them.

## Decisions recorded on their own

These began as addenda here and were moved to their own records on 2026-11-01, text unchanged:

- **Board value** (the projection, the two-pass pool, replacement level, the backtested settings, minutes in season and after an absence, age): [ADR 0009](0009-board-value.md).
- **Availability calibration** (the games a listed player is expected to miss, from past official listings): [ADR 0010](0010-availability-calibration.md).
- **Streamers sort** (what a player adds to the week): [ADR 0011](0011-streamers-sort.md).
- **Signals tested and not built** (defence by position, expected games, the board's line, the betting line, a teammate's absence, referee crews): [ADR 0012](0012-signals-tested-and-not-built.md).

## Consequences

- `dim_player.valid_from` is a game date, so a player traded between games is attributed to the new team from their first game there.
- Team turnovers are visible as the difference between `fct_team_game.turnovers` and the players' sum.
- Completeness is checked against the schedule, so the gate stays blocked until the full backfill has landed; that is the intended signal, not noise.

## Addendum (2026-10-29): availability, rest of season and lineups

**Availability.** ESPN's injury feed names the athlete but carries no athlete id, so `fct_availability` links each listing by name within the team: through the ESPN roster to the athlete id and the player crosswalk, or straight to the league player currently on that team. `is_current` marks the latest report. The board turns the report into an availability multiplier: the share of the team's remaining regular-season games the player is expected to play (out: the games before the expected return, or all of them without a date; doubtful 0.75 of a game, questionable 0.5, day-to-day 0.25). *The fixed charges for doubtful, questionable and day-to-day were replaced by ones calibrated on past official listings: [ADR 0010](0010-availability-calibration.md).*

**Rest of season** counts regular-season games only, the ones fantasy leagues score. Once a league's regular season is over (playoffs or the off-season) the board marks `season_complete` and the rest-of-season value equals the blend, instead of scaling everyone to zero.

**Lineups.** `silver.event_lineups` gives every play-by-play action the five players on the floor per side. The feed's substitution names only the player leaving by id; the player coming on is matched against the game's box score by a ranked set of name rules: surname with any given-name prefix the feed adds to tell teammates apart ("K. Mitchell", "Jal. Williams"), suffix kept so "Carter Jr." is not his teammate Carter; then surname without the suffix; then the first part of a hyphenated surname, for names that changed since (the box score says "Laney-Hamilton", a 2019 substitution says "Laney"); then given name, for names the feed writes in the other order; then the last word of a longer name. A dbt unit test pins each rule. Events are ordered by game clock within the period, because the feed logs some substitutions late and action numbers are not chronological. Period starters come from the box score in the first period and are inferred afterwards (a first substitution out, or an action before any substitution in). Over the full history every season has five a side on at least 93.5% of actions: 98.6% to 99.3% for each NBA season, 99.1% or better for WNBA 2020 to 2026, and 93.5% and 94.8% for WNBA 2018 and 2019, whose feed misses more substitutions. A warn check flags any season under 90%.

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

## Addendum (2026-10-30): a ledger for the signals that have no history yet

The newer inputs (official injury reports, lineups, the ESPN market, Sleeper, headline flags) have only days of history, and the published builds that carry them roll off after seven builds. None of them can be backtested unless the board's view is kept. `gold.fct_board_history` keeps it: one row per Eastern date, league and player with the projection, the value, availability, lineup role, market rank and ownership bucket, stakes, and the streamer signals. Every build merges the day's rows and a later build the same day replaces them. The model sets `full_refresh=false`, so a full refresh never rebuilds it and the history only grows (about 1,100 rows a day). `gold.fct_game_line` publishes the closing line for every played game, which the context analyses need.

`ops.feed_freshness` gives each feed's newest landing day and its age against the age the feed may reach while the league is playing. A feed that stops keeps its last snapshot in silver and gold, where it would otherwise look current. `warn_stale_feeds` flags a stale feed, or a feed that has never landed in season, and Data Health lists every feed.

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

## Addendum (2026-11-01): the evening run lands the 5 pm report too

The calibration (above) is measured on each day's 5 pm Eastern report, the one the history run lands, while the evening ingest landed whatever report was newest at 23:00 UTC (7 pm EDT, 6 pm EST): the production input and the calibration's data were different reports. An evening run now lands the day's 5 pm report as well when the day has passed 5 pm and the newest report is a later one. The two land under their own keys (the publish time), so both are kept; the board still reads the newest listing for the next game, and the calibration keeps reading the 5 pm one.

## Addendum (2026-11-01): one place for the current season, the schedule's sides and the team lookup

The gold models decided "the current season" three ways (the latest season in the season lines, in the games, in the standings) and "in season" four ways, carried six copies of the latest-team-name lookup, three of the schedule's home-and-away union and two of the newest-headline window. They now read `int_league_season_state` (every definition, named for what it means), `silver.team_current`, `silver.schedule_team_games` and `int_player_news_latest`. No definition changed: each model reads the column that is its old definition, so every table is byte-identical; the discrepancy between the standings season and the games season in the preseason is now written down in one place rather than hidden in three.

## Addendum (2026-11-01): the current stint listens to the roster

Stints came only from box-score appearances, so a player traded but not yet played for the new team kept the old `team_id` in `dim_player`, and a rostered player with no appearance (a rookie before the opener, a two-way player) had no row. Four gold models link listings by name within the player's current team (`fct_player_status`, `fct_availability`, `fct_waiver_trend`, and the official listing through them), and `warn_official_injury_links` and `warn_sleeper_links` exist because of the misses. The current stint now also reads the latest roster landing: a roster that names a team the player has not appeared for, landed after their last game, opens a stint on the landing date, and a rostered player with no appearance gets their first stint from it. History stays appearance-based; the roster only ever adds or moves the current stint, and a consecutive start for the same team (the roster, then the first game) collapses into one.

## Addendum (2026-11-01): what the marts assert

The marts carried keys and categories without tests on them: `mart_board.player_sk` and `mart_streamers.player_sk` could point at no stint, `fct_game_line.game_id` at no game, `fct_player_prop` at no game or player, and the board's `injury_group`, `ownership_bucket`, `team_stakes` and `news_flag` could take any value a refactor let through. `dim_player`, which every mart joins on its current stint, had nothing asserting one current stint per player or that stints do not overlap, and the two things the board's value depends on most, the two-pass pool and the availability multiplier, had no unit test.

Decisions:

- `relationships` tests on the marts' keys: the two `player_sk` to `dim_player`, the game line's `game_id` to `dim_game` (it is the closing line of a played game), the props' `game_id` to the schedule (a prop is quoted before the game is played, so `dim_game` may not have it yet) and their `player_id` to `dim_player`. The name-matched ids (`fct_official_listing.player_id`, `fct_player_prop.player_id`) are matched within rosters and the directory, a wider set than the players with a stint, so those two relationships warn rather than fail; the gap they report is `dim_player`'s (stints come from appearances and the current roster), not the matching's.
- `accepted_values` on the board's four categories and on `dim_game.season_type`, and `not_null` on the board's keys, pool flag, rank and remaining games.
- Two singular checks on `dim_player`: exactly one current stint per player (`is_current` and a null `valid_to`, the same row) and stints that follow one another with no overlap and no open stint behind a later one.
- Two unit tests on `mart_board`: the pool is chosen in two passes (a player who scores like a pool player but plays few minutes is pooled, a player who plays many but scores like a replacement is not) and the availability multiplier takes every branch it has (nothing left to play, a return date, out for the season, calibrated on past listings, no status, and the three old charges). The z-scores themselves are square roots and are not pinned to decimals; the availability test's lines are zero so every factor it pins is exact.
- No `dbt_utils`: every check here is one `relationships`, `accepted_values` or singular test, and the project stays without packages to install on both engines.

## Addendum (2026-11-01): silver types what gold reads; a key to nothing is null

Three columns crossed from silver into gold as text: the roster's birth date ("JUN 10, 1996"), parsed with `stats_birth_date()` in three gold and silver models; the roster's height ("6-4"); and the two tip-off times, the schedule's `game_datetime_utc` and ESPN's `event_datetime_utc`, carried as ISO 8601 strings into `dim_game` and `mart_schedule_upcoming`. And `sk()` built its hash with `concat_ws`, which skips nulls, so `fct_team_game.opponent_team_sk` for a game whose opponent's box had not landed was `md5('league:season')`, a non-null key that matches no team.

Decisions:

- Silver types the column once, where it is parsed: `rosters.birth_date` is a date and `rosters.height_inches` the number beside the text; `schedule.game_datetime_utc` and `espn_events.event_datetime_utc` are instants (`utc_timestamp()`: `timestamptz` on DuckDB, `timestamp` on Databricks; ESPN's to-the-minute text is handled, and `espn_ts` is the same macro under the name the ESPN models used). `utc_to_eastern_date()` takes the typed instant; the one caller with raw text wraps it. The three readers of the birth date drop their parse; `dim_player` carries `height_inches` with the text.
- `sk()` is null when any part is null. Every key whose parts are all present hashes exactly as before (the CI sample is byte-identical on every key), and a `relationships` test on `opponent_team_sk` now means what it says, since a null is not checked and a hash of the parts that were there would have failed it.
- Two unit tests pin the typing (`rosters_type_height_and_birth_date`: text that does not parse is null, not an error) and the null key (`team_game_without_an_opponent_box_has_no_opponent_key`).

Consequences:

- The exported player file's `birth_date` is now an ISO date ("1996-06-10") rather than the roster's text; the site types it as a string and shows height from the text, which is unchanged. The upcoming-schedule export's `game_datetime_utc` is an instant serialised with its offset ("2026-04-25T19:00:00+00:00") rather than the schedule's "Z" text; nothing on the site reads it yet.
- A full refresh is not needed: every model here is a table rebuilt each run.

## Addendum (2026-11-01): the ledger's holes are reported

`fct_board_history` is merged by every build and never rebuilt, so a nightly build that fails leaves a day with no rows, and the only other copies of that day are the seven kept builds, which roll off in a week. Nothing reported the hole. `warn_board_history_gaps` now lists every Eastern date of the last 45 days, from the league's first snapshot on and while the league was playing, that has no snapshot; the runbook's "Fill a hole in the board ledger" puts a day back from a kept build's Parquet by naming the columns and inserting only that day. The check warns rather than fails, since the build that notices the hole is not the one that caused it.

## Addendum (2026-11-01): games per team per fantasy week

`mart_schedule_upcoming` is a hard fourteen-day window and the board carries only `games_next_7` and `games_this_week`; `dim_date.fantasy_week` was read by no model. The one schedule surface a fantasy manager plans on and the platform did not have is which teams play four times, and which twice, in each week to the end of the season, the fantasy playoff weeks above all.

Decisions:

- `gold.fct_team_week_games`: one row per league, season, team and fantasy week from the current week to the last scheduled game, from each team's side of the schedule (`silver.schedule_team_games`) joined to `dim_date` for the week. `games` counts the week's regular-season and playoff games played or not, `games_left` the ones still to play from today, `games_if_necessary` the playoff games that may not happen, and `game_dates` every date. A unit test pins the week boundary (the current week counts from its Monday, last week is not a week ahead) and the if-necessary split.
- The table is exported as Parquet with the others and as a per-league JSON (`team_weeks/<league>.json`); the Streamers page shows it as a grid under the week grid, teams ordered by games left to play, four-game weeks marked, when the season has a week ahead. Older builds without the file show nothing.
