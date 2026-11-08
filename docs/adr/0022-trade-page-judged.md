# 0022. The Trade page, judged on simulated leagues

Date: 2026-11-08
Status: Accepted

## Context

The Trade page (`web/src/lib/trade-fairness.ts`, `trade-impact.ts` and `trade-suggest.ts`, and the lenses in `league-model.ts`) makes four kinds of call:

- **The verdict:** three lenses (value, market and categories), a severity (fine, bad or terrible) and "even".
- **The categories a trade moves:** up or down, conceded or locked.
- **The suggestions:** packages to offer for a player the manager wants.
- **The finder:** the best trades with every other team.

Every threshold behind those calls was assumed: the lens limits, the even band, `trade.meaningful_gain` and the bands on the chances. The methodology (#751) requires each call to beat a naive manager out of sample, or to be reworked or removed. #756 is that test. Its pass bar was declared on the issue before any run.

## Options considered

- **Judge the lenses on player values alone.** That says nothing about what a trade does to the categories a manager wins.
- **Replay the decisions on #755's simulated leagues (chosen).** Every finder trade is tried between every pair of teams. Each side's realized change is then scored against the real box scores.

## Decision

**The harness** is `ops.trade_backtest`. It runs on the Backtest workflow with the `trades` input, on the inputs `ops.walk_forward --standings-out` writes.

- **The rules:** `ops/trade.py`, the web's rules in Python. `tests/fixtures/trade_parity.json` pins it to the TypeScript, and both test suites check it. `tests/test_trade_backtest.py` holds the harness's array forms to `ops/trade.py`, trade by trade.
- **The leagues:**
  - At each of the four checkpoints, #755's 200 drafted leagues, of which the first 20 are traded in (`backtest.trade_leagues`).
  - In each, every one-for-one, two-for-one and one-for-two trade over each side's 8 most valuable players, the roster spots settled as `rostersAfter` settles them.
  - What happened: each side's realized change over the rest of the season, from the real box scores. In head-to-head, that is categories won a week against every other team; in rotisserie, points.
- **Intervals:** 95%, from 1,000 resamples of the season's weeks. Each judged season is judged on its own, each format separately, pooled over the checkpoints.

**The fit,** on the tuning seasons only, by the rule declared on #756:

- **Tuning seasons:** NBA 2020-21 to 2022-23 (runs 42478335636, 42478338072, 42478340676) and WNBA 2021 to 2023 (runs 42478343718, 42478346505, 42478349501).
- **The pick:** the finder replay's best `trade.meaningful_gain` was the smallest the grid allows. That is 0.00 in the NBA and 0.01 in the WNBA. Every predicted gain the finder found, however small, was worth making on average.
- **The lens thresholds:** they follow from the meaningful gain, so in the NBA every one of them collapsed to 0. Any trade that gives up any value is then "terrible", no trade is "even", and the category lens is switched off.

**Judged out of sample, with the fitted values** (commit 85cf128): NBA 2023-24 (run 42482093632), NBA 2024-25 (42482095888), WNBA 2024 (42482098021) and WNBA 2025 (42482101002). The bar requires each condition in every judged season.

| Part | Verdict | Where it fails |
| --- | --- | --- |
| The finder | Fail | its partners lose, NBA 2024-25 (both formats) and WNBA 2025 (head-to-head) |
| The suggestions | Fail | the naive manager's package does as well or better in NBA 2023-24 and both WNBA seasons |
| The verdict's number | Fail | slope 1.27 and 1.43 in NBA 2023-24, 1.34 in WNBA 2024 rotisserie |
| Even | Fail | none are called in the NBA, and WNBA "even" trades miss the ±m band |
| Bad or terrible | Pass | – |
| Categories up and down | Pass | – |
| Conceded and locked | Pass | – |

**The finder** gains the manager a lot, and with intervals clear of zero everywhere:

- **Head-to-head:** +0.03 to +0.16 categories a week.
- **Rotisserie:** +1.1 to +4.0 points.

But the win-win it promises does not hold:

- **NBA 2024-25:** its partners lose 0.089 categories a week (−0.116 to −0.058) and 0.76 rotisserie points (−1.33 to −0.21).
- **WNBA 2025, head-to-head:** they lose 0.023 (−0.045 to −0.0004).

In the NBA the judged naive manager never trades: with the lens limits at 0, no trade gains it value that its partner would accept. So "beats the naive manager" there only repeats "beats standing pat".

**The suggestions** beat standing pat in the NBA, but they lose to the naive manager's package (the page's own no-model rule on season-so-far value):

- **WNBA 2024:** −0.138 categories a week (−0.204 to −0.060) and −2.7 points.
- **WNBA 2025:** −0.065 (−0.118 to −0.016) and −1.2 points.
- **NBA 2023-24:** they are no better (−0.005, −0.022 to +0.017).
- **WNBA 2024:** they do not beat standing pat either.

**The verdict's number:** what happened moved more than the predicted gain said in three season-formats (slope 1.24 to 1.43). The gains are too timid there. In NBA 2024-25 and WNBA 2025 the slope is within the bar (0.88 to 1.18).

**Even** cannot pass with the fitted thresholds:

- **NBA:** a meaningful gain of 0 calls nothing even.
- **WNBA:** the band is ±0.01, and the even trades miss it: +0.033 (−0.026 to +0.096) in 2024 and +0.074 (+0.027 to +0.126) in 2025.

**What passes, in every judged season and format:**

- **Bad or terrible:** trades called bad or terrible lose, with every interval below zero.
- **Up and down:** a category the trade lists as up gains share against the rivals, and one listed down loses it. Both sit about 0.08 to 0.14 from zero.
- **Conceded and locked:** a category called conceded is won 15% to 23% of the time, and one called locked 76% to 85%, close to the chances behind them.

**Reported, not gated: the thresholds as they were registered** (run locally on the judged runs' inputs with `ops.trade_backtest`). At the old 0.05 meaningful gain and lens limits:

- **Even, head-to-head:** calibrated in the WNBA, at −0.010 (−0.026 to +0.005) and +0.009 (−0.003 to +0.022), inside ±0.05.
  - In the NBA it is not: +0.048 (+0.034 to +0.061) in 2023-24, against +0.026 (+0.006 to +0.045) in 2024-25.
  - In rotisserie, NBA 2023-24's even trades gain +0.72 points (+0.28 to +1.17), outside ±0.55.
- **"Bad" alone** (not terrible) gains in NBA 2023-24: +0.031 (+0.018 to +0.043).
- **The naive manager wins in the WNBA.** It may take up to 15% more season-so-far value than it gives, and it beats the finder in WNBA 2024 (−0.083, −0.158 to −0.003).
  - In the NBA the finder beats it in 2023-24 and ties it in 2024-25.
- **The finder's partners still lose in NBA 2024-25:** −0.065 (−0.086 to −0.043).

The fit's collapse to 0 says the meaningful gain cannot be set by the replay. Any positive predicted gain is worth taking, so the replay has no reason to call a trade even. "Even" needs a calibration band instead.

**What changes on the site:**

- **The thresholds:** they failed, so the fitted values do not ship. The registry keeps the values it had, now with this evidence.
- **The badges:**
  - The Verdict keeps "not yet validated", linked to the rework of the even band and the gain's scale (#886).
  - The Suggested trades keep theirs, linked to #887.
  - The trade finder keeps its own, linked to #888.
- **`trade.category_change` and `trade.chance_bands`:** they passed, and their entries say so.

## Consequences

- **A failing part is reworked or removed,** and nothing visible is removed without the owner's call. The recommendations are on #886, #887 and #888:
  - **Even:** derive the band from the predicted gain's measured error, not from the replay.
  - **The suggestions:** rank and filter them the way the finder is, or remove them.
  - **The finder:** require the partner's predicted gain to clear the meaningful gain, or drop the win-win label.
- **The judged seasons are spent** for these thresholds: NBA 2023-24 and 2024-25, and WNBA 2024 and 2025. A re-fit must be judged on seasons that it has not seen, starting with 2026-27.
- **The NBA judged runs read the fitted values** (commit 85cf128). The values the site keeps were judged only locally, as reported, not gated.
- **Neither #848 (the market prior on the web's own values) nor #868 (Fit weights) changes these lenses.** The value lens reads rest-of-season value, which #848 will blend toward the market, so the verdict should be re-judged once #848 lands. The "swing" categories (`teamNeeds`) read the standings weights, but they are only displayed.
- **Not tested here:**
  - the week unit;
  - points leagues;
  - the position check;
  - the week's matchup before and after (#869);
  - the locked seasons, NBA 2025-26 and WNBA 2026, are untouched.
