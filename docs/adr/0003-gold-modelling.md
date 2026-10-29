# 0003. Gold modelling choices

Date: 2026-10-27
Status: Accepted

## Context

Phase 3 turns the typed silver layer into the star schema and fantasy marts the app, notebooks and BI read, and adds the quality checks that gate publishing. A few choices were not dictated by the spec and are recorded here so they are not relitigated.

## Decisions

**Player stints come from appearances, not from the player directory.** `dim_player` is SCD type 2 on team. The directory (`commonallplayers`) only knows a player's current team, and daily snapshots exist only from the day ingestion started, so team history for the backfilled seasons has to come from where the player actually played: a stint starts at the first game with a new team and ends the day before the next team's first game. Names, position and biography come from the directory and rosters. The ESPN id column waits for the phase 4 crosswalk.

**Box score closure excludes turnovers.** On real data every counting stat sums from player rows to the team row exactly, except turnovers: the team figure includes team turnovers (shot-clock, 8-second and inbound violations) that belong to no player. The error-severity closure check covers every other stat; a warn-severity check asserts the team figure is at least the players' sum and not more than eight above it.

**Pool for z-scores is by total minutes.** The spec fixes the pool size (top 180 NBA, top 90 WNBA) but not the ranking; total minutes in the window is the least surprising proxy for "fantasy-relevant player" and does not depend on the categories being scored. Percentages use a volume-weighted impact ((player pct - pool pct) x attempts per game) standardised over the pool, never a plain average.

**Blend weights hand missing seasons to the others.** Current 0.30 rising linearly to 0.80 at 20 games; last season 0.55 and the season before 0.15 share what remains in that ratio; a missing season gives its weight to the rest so a rookie is scored on current-season data alone.

**Fixture sample is a shape fixture.** The sample built from recorded fixtures has a few rows per payload and is not a coherent season, so the data-quality checks (`tag:quality`) run only against real data in the nightly build; CI runs the structural tests (keys, relationships, accepted values) and the gate on the sample.

**Lineups and tracking facts are deferred.** `fct_event` reserves lineup columns; deriving the five on the floor needs substitution tracking across periods and is its own piece of work. `fct_player_tracking_season` needs the tracking endpoints, which are not ingested yet. Both are listed for phase 5 or 6 alongside the surfaces that would show them.

## Consequences

- `dim_player.valid_from` is a game date, so a player traded between games is attributed to the new team from their first game there.
- Team turnovers are visible as the difference between `fct_team_game.turnovers` and the players' sum.
- Completeness is checked against the schedule, so the gate stays blocked until the full backfill has landed; that is the intended signal, not noise.

## Addendum (2026-10-29): availability, rest of season and lineups

**Availability.** ESPN's injury feed names the athlete but carries no athlete id, so `fct_availability` links each listing by name within the team: through the ESPN roster to the athlete id and the player crosswalk, or straight to the league player currently on that team. `is_current` marks the latest report. The board turns the report into an availability multiplier: the share of the team's remaining regular-season games the player is expected to play (out: the games before the expected return, or all of them without a date; doubtful 0.75 of a game, questionable 0.5, day-to-day 0.25).

**Rest of season** counts regular-season games only, the ones fantasy leagues score. Once a league's regular season is over (playoffs or the off-season) the board marks `season_complete` and the rest-of-season value equals the blend, instead of scaling everyone to zero.

**Lineups.** `silver.event_lineups` gives every play-by-play action the five players on the floor per side. The feed's substitution names only the player leaving by id; the player coming on is matched by surname, or by given name for names the feed writes in the other order, against the game's box score. Events are ordered by game clock within the period, because the feed logs some substitutions late and action numbers are not chronological. Period starters come from the box score in the first period and are inferred afterwards (a first substitution out, or an action before any substitution in). On a real WNBA week 99% of actions have five a side; a warn check flags any season under 90%.
