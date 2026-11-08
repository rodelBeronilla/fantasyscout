# 0029. A points league's playoff odds: the weekly spread measured, the odds judged

Date: 2026-11-08
Status: Accepted

## Context

A head-to-head points league's Playoffs tile (#877, `pointsPlayoffOdds`) plays the rest of the season week by week.

- **The chance:** each matchup goes to a side with the chance that a normal margin falls its way.
- **The margin:** its mean is the gap between the two teams' projected fantasy points per game. Its spread is `playoffs.points_spread_share` of the league's average team.

That spread, 0.17, was a prior: a third of a player's mean a game, over 35 games a week, doubled. #891 asked for two things:

- measure the spread on the simulated leagues;
- judge the odds as #872 judged the category odds (ADR 0025).

The pass bar was declared on #891 before any run.

## Options considered

- **Keep the prior and judge it.** That would judge a number nobody had measured.
- **Measure the spread, add a lasting share and judge both (chosen).**
  - #872 found the category odds far too sure with independent weeks.
  - So a lasting share for points, `playoffs.points_season_share`, was fitted beside the spread on the tuning seasons, declared in the bar.

## Decision

**The harness** is `ops.points_backtest`, on the Backtest workflow's new `points` input (with `standings`). It plays #872's leagues as points leagues.

- **The scoring:** ESPN's default (`POINT_PRESETS.espn`), applied to the board's projected per-game line. `ops.standings_backtest`'s checkpoint export now carries `proj_*_pg`.
- **The draft:** #755's snake draft, by projected fantasy points per game.
- **The model:** a team's projection is fantasy points per game × availability. The odds are `ops.playoffs`, the web's simulation draw for draw. A fixture case pins a points league (one category, one result a week, a lasting share).
- **What happened:** each team's real fantasy points each fantasy week, with #872's schedule, record so far and cut.
- **Both parameters are per league now,** so `pointsPlayoffOdds` takes the league.

**The fit,** on the tuning seasons only. The runs are 42514378363, 42514380629, 42514383087, 42514385913, 42514388109 and 42514390535: new exports of #755's builds.

- **The spread, measured:** √(mean (r − μ)²) over every week from each checkpoint on, every league and pair. Here r is the real margin ÷ the league's average team that week, and μ is the projected gap ÷ the average projected team.
  - NBA: **0.271**. WNBA: **0.35**.
  - At the prior, the z-scores' standard deviation was 1.59 and 2.06. The prior was about half what the weeks show.
- **The lasting share:** **0 in both leagues, on the grid's edge.** Every step up to 0.8 raised the log loss of the odds (NBA 0.5905 to 0.6161, WNBA 0.5690 to 0.5856).
  - It keeps the form `playoffs.season_share` has. #900 (ADR 0028) left that form at one number per league.
- **Checked first,** the slopes at 0:
  - NBA first game day: 0.23 to 0.70;
  - WNBA first game day: 0.27 to 1.11;
  - later checkpoints: 0.72 to 1.57.

**Judged on NBA 2023-24 (run 42519149453), NBA 2024-25 (42519152350), WNBA 2024 (42519156785) and WNBA 2025 (42519159987): fail in all four.**

- **The spread holds out of sample:** the weekly z-scores' standard deviation is 0.87 to 1.08.
- **In season the odds beat both baselines everywhere:**
  - the coin, by +0.012 to +0.120;
  - the naive manager, by +0.030 to +0.093;
  - every interval is clear of zero.
- **They are too sure where they fail** (0.8 to 1.25 to pass):

| Season | Where it fails |
| --- | --- |
| NBA 2023-24 | first game day: slope 0.62, and the coin not beaten (+0.001, −0.002 to +0.003) |
| NBA 2024-25 | first game day: slope 0.10, worse than the coin (−0.005, −0.008 to −0.001); a tenth: 0.74 |
| WNBA 2024 | a quarter: 0.70 |
| WNBA 2025 | first game day: 0.79; a quarter: 0.77 |

- **The NBA's first game day fails in every NBA season seen,** tuning and judged. A preseason fantasy-points projection orders NBA teams little better than a coin.

**What changes on the site:**

- the measured spread replaces the prior;
- the lasting share is registered at its fit, 0, so the draws are unchanged;
- the basis text says the week's swing is measured on past seasons;
- the Playoffs tile in points leagues keeps its "not yet validated" badge, now linked to #913.

## Consequences

- **The judged seasons are now spent for the points odds.** A rework must use folds within the tuning seasons (ADR 0022), or wait for the locked seasons.
- **#913 (the owner's call)** sets out the options:
  - no points odds at the first game day (recommended now);
  - a preseason spread fitted by folds;
  - pooled calibration judged on the locked seasons with #907.
- **Removing the tile is not recommended.** In season it beats the current standings everywhere.
- **Not tested:**
  - benches and lineups: every rostered player plays here, while the web counts every active player's games;
  - other scoring presets;
  - ESPN's own schedules;
  - checkpoints after half way.
