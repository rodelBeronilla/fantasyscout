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
