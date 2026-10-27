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
