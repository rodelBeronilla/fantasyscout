# 0027. Buy low, sell high, judged on simulated leagues

Date: 2026-11-08
Status: Accepted

## Context

The Trade page's Buy low, sell high (`web/src/lib/buy-sell.ts`, #739) lists the manager's players whose last ten games run `buysell.min_swing` above their projection (sell high). It also lists healthy players elsewhere, slumping that far below a projection good enough to start for the manager (buy low).

The swing of 1 a game was assumed. The methodology (#751) requires the lists to beat a naive manager out of sample, or to be reworked or removed. #758 is that test. Its pass bar was declared on the issue before any run.

## Options considered

- **Judge the projection alone (#754).** That says nothing about whether a swing from it is a signal.
- **Judge the lists every simulated team would see (chosen).** Each flagged player's realized value is checked against their last ten and against the naive manager's lists.

## Decision

**The harness** is `ops.buy_sell_backtest`. It runs on the Backtest workflow with the `buy_sell` input. `ops.walk_forward --buy-sell` exports last ten's categories, the injury listing and the market prior's columns beside the standings inputs.

- **The rules:** `ops/buy_sell.py`, the web's rules in Python. `tests/fixtures/buy_sell_parity.json` pins it to the TypeScript, and both test suites check it. `tests/test_buy_sell_backtest.py` holds the harness's lists to `ops/buy_sell.py`, team by team.
- **The lists:** every team of #755's 200 drafted leagues, at each checkpoint, reads its two lists.
  - The values are the web's. The projection is the nine categories plus the market prior's shift (#848); the form is last ten's nine categories.
- **What happened:** each flagged player's realized value per game over the rest of the season (`ops.walk_forward`'s `realized_value`), for a player with 10 or more games after the cut.
- **The naive manager's lists:** the season so far in place of the projection.
- **Intervals:** 95%, from 1,000 resamples of the season's players.

**The fit,** on the tuning seasons only, by the rule declared on #758. It is RMSE / (1 − β): the swing whose expected reversal reaches the projection's own error.

| League | Runs | β (share of a swing that persists) | Projection RMSE a game | `buysell.min_swing` |
| --- | --- | --- | --- | --- |
| NBA 2020-21 to 2022-23 | 42497379530, 42497589265, 42497591494 | 0.016 | 2.11 | 2.1 (was 1) |
| WNBA 2021 to 2023 | 42497382072, 42497384719, 42497593781 | 0.31 | 4.10 | 5.9 (was 1) |

Last-ten form beyond the projection barely persists in the NBA.

**Judged out of sample** on NBA 2023-24 (run 42508222884), NBA 2024-25 (42508225313), WNBA 2024 (42508227498) and WNBA 2025 (42508229740). The first dispatch of these runs scored a resample that drew none of the flagged players as 0, not as missing. Commit c659b4e fixed that, and the runs above are the re-runs.

Values are per game; "vs naive" is the tool's reversal minus the naive list's.

| | NBA 2023-24 | NBA 2024-25 | WNBA 2024 | WNBA 2025 |
| --- | --- | --- | --- | --- |
| Buy low: realized − last ten | +3.46 (+2.86 to +4.04) | +3.93 (+2.92 to +5.20) | **no flags** | +9.19 (+7.61 to +10.73), 2 players |
| Buy low: vs naive | +1.01 (+0.40 to +1.82) | +2.22 (+0.36 to +4.64) | **–** | +4.73 (+0.70 to +11.26) |
| Buy low: the projection's advantage | +12.1 (+8.7 to +15.6) | +19.6 (+10.7 to +31.6) | **–** | +81.1 (+57.4 to +104.0) |
| Sell high: last ten − realized | +3.18 (+2.73 to +3.64) | +3.32 (+2.89 to +3.74) | +6.82 (+4.35 to +9.41) | +6.78 (+5.01 to +8.40) |
| Sell high: vs naive | **+0.13 (−0.48 to +0.72)** | **+0.23 (−0.35 to +0.79)** | **no naive flags** | **−3.11 (−4.94 to −1.37)** |
| Sell high: the projection's advantage | +11.5 (+8.3 to +14.9) | +13.0 (+9.7 to +16.3) | +48.4 (+1.9 to +97.2) | +46.7 (+21.3 to +78.5) |

Bold marks a failed condition.

| List | Verdict | Where it fails |
| --- | --- | --- |
| Buy low, NBA | **Pass** | – |
| Buy low, WNBA | Fail | no flagged player in 2024; two in 2025 |
| Sell high | Fail | no better than the naive manager's list in any season |

- **Buy low works in the NBA.** A flagged player went on to produce 3.5 to 3.9 a game more than their last ten, and 1.0 to 2.2 more than the naive manager's picks. The projection is a far better guess for them than last ten.
- **Sell high's players do fall back,** and the projection is the better guess for them too. But the naive manager's list (last ten against the season average) finds players who fall back as far.

**What changes on the site:**

- **`buysell.min_swing` is 2.1 (NBA) and 5.9 (WNBA),** now per league. `buySell` reads the league's own, and the page states it.
- **The badges:**
  - The card-wide "not yet validated" badge is gone.
  - "Sell high" keeps one, linked to #903.
  - "Buy low" keeps one only in WNBA leagues, linked to #904.

## Consequences

- **Sell high (#903)** is reworked or removed; that is the owner's call. The recommendation is to rank by the market's overrating rather than by last ten, or to drop the list.
- **The WNBA (#904):** a swing of 5.9 leaves the lists too thin to judge. Its swing needs a scale that allows for its shorter season, or the leagues' β pooled.
- **The judged seasons are spent** for this parameter. A re-fit is judged from 2026-27 (NBA) and 2027 (WNBA).
- **Not tested here:** points leagues, which have no lists. The locked seasons, NBA 2025-26 and WNBA 2026, are untouched.
- **#868 (Fit weights) does not touch the lists.** The projection carries #848's market prior, which merged before this ran. The replacement offset that `categoryValues` takes from both windows is the same for both, so the swing does not see it.
