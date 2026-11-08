# 0025. The playoff odds, judged on simulated leagues

Date: 2026-11-08
Status: Accepted

## Context

The Playoffs tile (#821, `web/src/lib/playoff-odds.ts`) plays the rest of a head-to-head category season forward:

- each week each category of each matchup goes to a side with the standings model's chance;
- the records start from the league's;
- the top teams by winning share make the cut.

#755 (ADR 0021) validated the weekly chances. It did not test what the odds add: the schedule, the records carried in, the cut, and the assumption that every category of every week is drawn independently. A projection's miss lasts all season, so independent weeks should make the odds too sure. #872 is the test. Its pass bar was declared on the issue before any run.

## Options considered

- **Trust the weekly chances.** A calibrated week says nothing about a season of correlated weeks.
- **Judge on real leagues.** No past fantasy leagues are kept.
- **Extend #755's simulated leagues (chosen).** Give each league a schedule, a record so far and a cut, then judge the odds against who made it.

## Decision

**The harness** is `ops.playoff_backtest`, on the Backtest workflow's `playoffs` input (with `standings`).

- **The leagues:** #755's, drafted at the same four checkpoints.
- **The schedule:** the web's round robin over the regular season's fantasy weeks, the last `playoffs.weeks` held back. The top `playoffs.teams` make the cut.
- **The record so far:** the weeks that ended before the checkpoint, played on real box scores by the drafted rosters.
- **The odds:** `ops/playoffs.py`, the web's simulation draw for draw. mulberry32 is counter-based, so the Python computes the same draws in the same order. `tests/fixtures/playoffs_parity.json` pins the odds exactly.
- **Both tallies are judged:** categories and matchups.
- **The baselines:**
  - the coin, at the base rate;
  - the naive manager, the current standings order.
- **Intervals:** 95%, from resamples of the weeks still to play.

**A lasting share, `playoffs.season_share`, fitted on the tuning seasons only.**

- **How it works:** each simulated season draws one shift per team and category from that share of a week's spread, and the weeks draw from the rest. A week on its own keeps the validated chance.
- **The check came first:** at share 0 the tuning slopes were 0.31 to 1.13, mostly under 0.8. The odds were too sure.
- **The fit:** grid 0 to 0.8, the lowest mean log loss of the odds over the tuning checkpoints and both tallies.
  - NBA: 0.3 (log loss 0.6057 at 0 to 0.5961);
  - WNBA: 0.2 (0.5585 to 0.5552).

**Judged on NBA 2023-24 (run 42498681135), NBA 2024-25 (42498686229), WNBA 2024 (42498692099) and WNBA 2025 (42498697513): fail, on calibration only.**

- **They beat both baselines everywhere:** at every checkpoint, in both tallies and every season, by +0.012 to +0.128 over the coin and +0.012 to +0.169 over the naive manager, every interval clear of zero.
- **The slope fails in places** (0.8 to 1.25):

| Season | Tally | Where it fails |
| --- | --- | --- |
| NBA 2023-24 | matchups | 1.37, 1.32, 1.37 (first game day to a quarter): too timid |
| NBA 2024-25 | matchups | 1.29 (first game day), 1.33 (a quarter): too timid |
| WNBA 2024 | matchups | 1.41 (first game day): too timid |
| WNBA 2025 | categories | 0.77, 0.75 (first game day, a tenth): too sure |

- **The categories tally** passes in three of four seasons (slopes 0.90 to 1.21 there).
- **The likely cause:** one share serves two tallies that want different ones. Even at share 0 the matchups tally was much less sure than the categories one.

**What changes on the site:**

- The web's simulation draws the lasting shift, so the odds are less sure than before. The tuning seasons showed independent weeks far too sure.
- The Playoffs tile keeps its "not yet validated" badge in category leagues, now linked to the rework (#900): a share per tally, judged by leaving one tuning season out as in ADR 0022.
- Points leagues keep theirs (#891).

## Consequences

- **The judged seasons are now spent for the lasting share.** The rework must use folds within the tuning seasons, and the locked seasons stay untouched.
- **Removing the tile is not recommended.** It beats the current standings by wide margins, and its error is calibration of size, not of direction. The owner decides if the rework fails too.
- **Not tested:**
  - ESPN's own schedules;
  - rosters that change during the season;
  - checkpoints after half way.
