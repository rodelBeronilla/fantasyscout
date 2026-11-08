# 0021. The standings model, judged on simulated leagues

Date: 2026-11-08
Status: Accepted
Supersedes: 0015's spreads

## Context

The standings model (ADR 0015, `web/src/lib/standings.ts`) drives three things:

- **The category win chances on My Team:** the chance of beating an average rival in each category.
- **The power rankings.**
- **Fit:** the board's category weights.

Its spreads were measured per game. Two things in it were never tested:

- how per-game spreads add up to a week or a season;
- the rotisserie projection error (0.3), which was an assumption.

The methodology (#751) requires each part to beat a naive manager out of sample, or come off the site. #755 is that test. Its pass bar was declared on the issue before any run.

## Options considered

- **Validate on real leagues.** No past fantasy leagues are kept, so there is nothing to replay.
- **Validate player values only (#754) and trust the arithmetic.** That says nothing about whether a 70% chance wins 70% of the time.
- **Simulate leagues of real seasons (chosen).** At each walk-forward checkpoint (ADR 0018), draft leagues, let the model predict them, and score the predictions against what the real box scores then did.

## Decision

**The harness** is `ops.standings_backtest`. It reads the inputs `ops.walk_forward --standings-out` writes, and it runs on the Backtest workflow with the `standings` input.

- **The leagues:** at each of the four checkpoints, it drafts 200 leagues of the default size, in snake drafts where each pick is drawn from the five best players left (`backtest.standings_*`). Each team's realized weeks are summed from regular-season box scores. A category is won on raw totals.
- **The model:** `ops/standings.py`, the web's arithmetic in Python. `tests/fixtures/standings_parity.json` pins it to the TypeScript, and both test suites check it.
- **Intervals:** 95%, from 1,000 resamples of the season's weeks. Every simulated league shares the same games, so the weeks are what vary.
  - A resampled season total is noisier than the real one. That pulls a figure built from totals, such as a Spearman or a rotisserie Brier score, below its point estimate. So each interval is centred on its point estimate.

**Fitted on the tuning seasons only,** by the rule declared on #755:

- **Tuning seasons:** NBA 2020-21 to 2022-23 (runs 42466140329, 42468833908, 42466144841) and WNBA 2021 to 2023 (runs 42468836211, 42466314090, 42466316345).
- **`standings.spread_scale` = 2.0** in both leagues: a multiplier on the games' spread of the gap between two teams.
  - At 1, the head-to-head chances were overconfident. In the four tuning seasons judged at the old spreads, the calibration slope was 0.37 to 0.48, and the NBA log loss was 0.693, a coin flip's.
  - At 2.0, the log loss falls to 0.629 (NBA) and 0.640 (WNBA).
  - 2.0 is the edge of the grid.
- **`standings.projection_spread` = 0.8** in both leagues (assumed 0.3 before), with that scale fixed.

**Judged out of sample** on NBA 2023-24 (run 42471829313), NBA 2024-25 (42471831591), WNBA 2024 (42471834211) and WNBA 2025 (42471836676). The bar requires each condition in every judged season.

| Part | Verdict | Where it fails |
| --- | --- | --- |
| Head-to-head win chances | **Pass** | – |
| Rotisserie win chances | Fail | the first game day in every season |
| Power rankings, head-to-head | Fail | NBA 2023-24 half way |
| Power rankings, rotisserie | Fail | NBA 2023-24 half way; NBA 2024-25 a tenth in and half way |
| Fit, either format | Fail | does not reliably beat equal weights |

**Head-to-head win chances, every checkpoint of every judged season.** The figures:

- **Brier score:** 0.212 to 0.226, against a coin flip's 0.243 to 0.246. They beat the coin with every interval clear of zero.
- **Against the naive manager:** they beat it in season, by 0.004 to 0.023, with the intervals clear of zero. At the first game day they are better too, by 0.0006 to 0.0026.
- **Calibration slope:**
  - NBA: 0.85 to 0.94;
  - WNBA 2024: 0.96 to 1.17;
  - WNBA 2025: 0.82 to 0.93.

**Rotisserie win chances** are calibrated in season (slopes 0.85 to 1.18). At the first game day they are too timid (slopes 1.79 to 2.42), and in WNBA 2025 they are worse than the naive manager there. One projection spread does not fit every horizon (#866).

**Power rankings** pass in the WNBA in both formats. In the NBA they weaken through the season and fail at half way, and rotisserie fails a tenth in as well in 2024-25. The market's mean draft rank of a roster ranks NBA teams far better, at every checkpoint: Spearman 0.22 to 0.52, against the model's −0.02 to 0.30. The likely cause is that the category values the standings read do not carry the market prior (ADR 0020, #848). The rework is #867.

**Fit** beats equal weights in two of four head-to-head seasons and one of four rotisserie seasons. In NBA 2024-25 it is worse than `fit.thirds`. Its gain over the naive manager comes from the board, not the weights (#868).

**What changes on the site:**

- The spreads are wider: `standings.spread_scale` and `standings.projection_spread`. Every chance, power ranking, Fit weight, Trade verdict and the playoff odds (#821) read them.
- In a head-to-head league, the "Your categories" tile loses its "not yet validated" badge.
- Rotisserie chances keep the badge, linked to #866. So do the power rankings (#867), Fit (#868) and the playoff odds. The playoff odds build on the head-to-head chances but add a schedule and a cut, which this test did not judge (#872).

## Consequences

- **A failing part is reworked or removed.**
  - Rotisserie chances and the power rankings each wait on a rework, with a removal named if it fails.
  - Fit's recommendation is to drop the standings weighting and rank by equal weights. That is the owner's call (#868).
- **The fitted scale sits at the edge of its grid.** The judged slopes just under 1 suggest the optimum is a little wider. A re-fit on a wider grid must use the tuning seasons and be judged on seasons the fit has not seen. NBA 2023-24 and 2024-25, and WNBA 2024 and 2025, are spent for these two parameters.
- **The draft makes the test strict.** Teams drafted by the board's own values are close by those values. A power ranking then has only the board's errors to separate them, which is why the market does so well.
- **Not tested here:**
  - `standings.rival_min_share`: a full simulated league cannot test a rule for a league still being entered.
  - `matchup.closeness`: it belongs to the week's matchup card (#869).
  - The locked seasons, NBA 2025-26 and WNBA 2026, are untouched.
