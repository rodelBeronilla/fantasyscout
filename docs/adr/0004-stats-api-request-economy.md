# 0004. Stats API request economy

Date: 2026-10-27
Status: Accepted

## Context

The spec lists the stats API endpoints to ingest and mandates one request at a time per host with a 1.5 to 3 second gap. With four calls per game (traditional box score, advanced box score, play-by-play, shot chart) a WNBA season costs about 1,000 requests and an NBA season about 5,000, so the full backfill was estimated at eleven hours and every nightly run scaled with the number of games.

Measured on 2026-10-27 from a residential connection:

| Request | Returns | Size, time |
| --- | --- | --- |
| `shotchartdetail` with no game id, one team | every shot of that team's season | about 3 MB, 1.4 s |
| `shotchartdetail` with no game id, no team | every shot of the season (WNBA 2026: 45,296 shots, 330 games) | 10.5 MB, 5.1 s |
| `playergamelogs`, MeasureType Advanced | every player-game line of the season with the same measures as `boxscoreadvancedv3` (6,587 rows) | 3.1 MB, 3.5 s |
| `playergamelogs`, MeasureType Base | every player-game counting line of the season | 2.4 MB, 2.9 s |

The advanced measures agreed with the per-game v3 payload for every player of the game checked (usage, ratings, PIE, true shooting, effective field goal, pace, possessions, assist percentage; none differed by more than 0.05).

## Decision

- Shot charts: one request per team-season for backfills (`--shots team-season`); per game for small daily windows.
- Advanced box lines: the season-level `playergamelogs` (Advanced) request replaces per-game `boxscoreadvancedv3` calls everywhere. Silver `player_game_advanced` reads both sources (the first backfilled seasons landed the v3 form) and keeps the latest landing per player-game.
- Traditional box score and play-by-play stay per game: the season game log lacks starters and DNP reasons, and play-by-play has no bulk form.

## Consequences

- Per-game cost falls from four calls to two; a WNBA season from about 40 to 20 minutes, an NBA season from about 3.2 to 1.7 hours; the nightly run makes one advanced request per league instead of one per game.
- Bronze `stats_playergamelogs` re-lands the whole season each day as games are added (the same pattern as the team game log); silver deduplicates.
- The pacing rule itself is untouched; relaxing it for backfills is a separate decision for the owner.

## Addendum (2026-10-27): long runs stall unless cookies are dropped

The first full backfill ran at the expected pace for about an hour, then every request from both runners hung until the 30 s read timeout, on new connections too, while a fresh client in the same container, from the same address, answered the identical request in under a second. The difference was the cookie jar: the stats hosts set bot-manager cookies (`ak_bmsc`, `bm_sv`) on every answer, the long-lived client sent them back, and once the cookie was scored badly the edge accepted each request and never answered it. A run that costs 20 minutes healthy would have taken days, and nothing in the job log showed it because the ingestor only printed at the end.

Decisions:

- The client clears its cookie jar before every request, so each one is as anonymous as the first.
- Backfills use a 20 s read timeout; with the circuit breaker at three consecutive timeouts, a host that stops answering ends the run in about a minute and the job fails visibly instead of looping.
- The ingestor prints a flushed progress line every 25 requests, so the job log shows the live rate and the summary at the end is no longer the only signal.

## Addendum (2026-10-30): usage, misc and NBA tracking

Inputs for later backtests (who takes the team's shots, who draws fouls, who creates assists), landed now so history builds up. No projection or value reads them yet.

Measured on 2026-10-30 from a residential connection:

| Request | Returns | Size |
| --- | --- | --- |
| `playergamelogs`, MeasureType Usage | every player-game of the season with the player's share of the team's box score while on the floor (NBA 2025-26: 26,651 rows) | NBA 9.5 MB, WNBA 1.8 MB |
| `playergamelogs`, MeasureType Misc | the same rows with points off turnovers, second-chance, fast-break and paint points, fouls drawn and blocks against | NBA 7.6 MB, WNBA 1.5 MB |
| `leaguedashptstats`, one PtMeasureType (Passing, Rebounding, Possessions, Drives, SpeedDistance), DateFrom = DateTo | one row per player who played that day | about 20 KB each |
| `leaguehustlestatsplayer`, DateFrom = DateTo | contested shots, deflections, charges, screen assists, loose balls, box outs per player that day | about 22 KB |

The WNBA host answers both tracking endpoints with no rows. Tracking has rows from 2013-14; hustle from 2015-16 (a handful of games that season, every game from 2016-17). On the day checked, tracking assists and points matched the box score for all 201 player-games and tracking minutes were within a minute.

Decisions:

- Usage and Misc join Advanced in the season plan: one call each per season and season type, both leagues. They land in the `playergamelogs` folder under their own keys (`usage-regular-season`, `misc-regular-season`); each measure set has its own bronze model, and `stats_playergamelogs` now reads only the `advanced-` keys.
- Tracking and hustle have no per-game or whole-season-of-games form, so they are fetched one game date at a time, NBA only: six calls per game date (five tracking sets and hustle), keyed by measure and date (`passing-2026-01-15`, `hustle-2026-01-15`). The dates are the game dates in the run's window, and each date settles like its games (`SETTLE_DAYS` after it), so a daily run fetches only the last few dates and a backfill's dates follow its window. Seasons before 2013-14 plan no tracking, and before 2015-16 no hustle.
- The tracking row's team is the player's team when it was fetched, not on the game date. Gold `fct_player_tracking` therefore takes the game and the team from the player's box score on that date.

Consequences:

- An NBA regular season has about 164 game dates, so tracking adds about 1,000 calls to its backfill and the playoffs about 360; at the 2.3 s gap, about 50 minutes per season. A nightly NBA run adds up to 18 calls (three unsettled dates), and the season plan two calls per league.
- The NBA daily season plan re-lands about 17 MB more (Usage and Misc grow with the season, like Advanced); silver keeps the latest landing per player-game.
