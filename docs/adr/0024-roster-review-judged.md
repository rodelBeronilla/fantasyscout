# 0024. My Team's roster review, judged on simulated leagues

Date: 2026-11-08
Status: Accepted

## Context

My Team's Moves (`teamReview` in `web/src/lib/team-review.ts`, with `dropRule` and `reviewRoster` in `roster-upgrades.ts`) names who to drop for which free agent. It rests on three choices that were never measured:

- **The drop rule:** a player the board or the market ranks among the league's starters (`roster.starter_share` of the roster spots) is never dropped.
- **The minimum gain:** a swap must gain `roster.min_gain` of rest-of-season value.
- **The trade chips:** a protected player whom a free agent beats is listed as "trade, don't drop".

The methodology (#751) requires each to beat a naive manager out of sample, or to be reworked or removed. #757 is that test. Its pass bar was declared on the issue before any run.

## Options considered

- **Judge the rest-of-season values alone (#754).** That says nothing about whether the swap they imply wins categories.
- **Replay each team's review on #755's simulated leagues (chosen).** The realized change is scored against the real box scores.

## Decision

**The harness** is `ops.roster_backtest`. It runs on the Backtest workflow with the `roster` input, on the inputs `ops.walk_forward --standings-out` writes. The export now carries the board's `rank_total` and the market prior's two columns.

- **The rules:** `ops/roster.py`, the web's rules in Python. `tests/fixtures/roster_parity.json` pins it to the TypeScript, and both test suites check it. `tests/test_roster_backtest.py` holds the harness's swap and chips to `ops/roster.py`, team by team.
- **The review:** each team of #755's 200 drafted leagues, at each checkpoint, reviews its roster. The swap is the best free agent for the lowest-valued player the rule lets go, made when it gains the minimum.
  - Values are the web's, with the market prior's shift (#848).
  - With no past ESPN market, the market's rank is the preseason draft order.
- **What happened:** the team's realized change over the rest of the season, from the real box scores. In head-to-head, that is categories won a week against every other team; in rotisserie, points.
- **Intervals:** 95%, from 1,000 resamples of the season's weeks. Each judged season is judged on its own, each format separately, pooled over the checkpoints.

**The fit,** on the tuning seasons only, by the rule declared on #757:

| League | Runs | `roster.starter_share` | `roster.min_gain` | Replay at the registry → at the pick |
| --- | --- | --- | --- | --- |
| NBA 2020-21 to 2022-23 | 42487581023, 42487583214, 42487585033 | 0.65 (was 0.6) | 0.0 (was 0.5) | +0.083 → +0.155 a week |
| WNBA 2021 to 2023 | 42487587073, 42487588817, 42487590681 | 0.8 | 0.2 | +0.0051 → +0.0066 |

The NBA's minimum gain sits at the grid's edge: every positive swap was worth making on average.

**Judged out of sample** on NBA 2023-24 (run 42492346430), NBA 2024-25 (42492348374), WNBA 2024 (42492350281) and WNBA 2025 (42492351996). Head-to-head is in categories a week, rotisserie in points.

| | NBA 2023-24 | NBA 2024-25 | WNBA 2024 | WNBA 2025 |
| --- | --- | --- | --- | --- |
| Review − standing pat (h2h) | +0.261 (+0.219 to +0.301) | **+0.089 (−0.003 to +0.183)** | +0.017 (+0.012 to +0.021) | **+0.001 (−0.004 to +0.007)** |
| Review − standing pat (roto) | +4.30 (+3.59 to +4.94) | **+1.08 (−0.62 to +2.70)** | +0.22 (+0.15 to +0.27) | **−0.00 (−0.06 to +0.08)** |
| Review − naive (h2h) | +0.381 (+0.337 to +0.431) | **+0.086 (−0.035 to +0.218)** | +0.107 (+0.082 to +0.129) | +0.118 (+0.082 to +0.150) |
| Review − no drop rule (h2h) | +0.001 (−0.001 to +0.003) | +0.005 (+0.002 to +0.008) | 0 | 0 |
| A chip dropped (h2h) | **+0.055 (−0.002 to +0.112)** | **−0.054 (−0.149 to +0.048)** | **+0.252 (+0.158 to +0.357)** | −0.109 (−0.182 to −0.032) |

Bold marks a failed condition.

| Part | Verdict | Where it fails |
| --- | --- | --- |
| The review's swaps | Fail | they do not beat standing pat in NBA 2024-25 or WNBA 2025 (either format), nor the naive manager in NBA 2024-25 |
| The drop rule | Pass | – |
| The trade chips | Fail | dropping a chip for the best free agent does as well or better in three of the four seasons |

- **The drop rule costs nothing.** The review with the rule is never worse than the review without it, and in NBA 2024-25 it is better: +0.005 (+0.002 to +0.008) a week, and +0.08 points.
- **The swaps:** they are worth a lot in NBA 2023-24 and WNBA 2024. In NBA 2024-25 they are positive but too noisy to clear zero; in WNBA 2025 they are worth nothing.
- **The naive manager** (drop the lowest season average for the best free agent by it) loses to standing pat in every season except NBA 2024-25.
- **The chips' claim fails.** A protected player whom the best free agent beats was worth keeping only in WNBA 2025. Elsewhere, swapping the chip for that free agent did as well or better.
  - Roto, NBA 2023-24: +1.16 points (+0.22 to +2.08).
  - WNBA 2024: +3.2 points.

**Reported, not gated: the values as they were registered** (0.6 and 0.5, run locally on the judged runs' inputs). The swaps gain less in every season:

| Season | Old values (h2h) | Fitted values (h2h) |
| --- | --- | --- |
| NBA 2023-24 | +0.181 | +0.261 |
| NBA 2024-25 | +0.057 | +0.089 |
| WNBA 2024 | +0.003 | +0.017 |
| WNBA 2025 | −0.000 | +0.001 |

At the old values, the drop rule is slightly worse than no rule in NBA 2023-24, by −0.0003 (−0.0005 to −0.0001) a week.

**What changes on the site:**

- **The fitted values ship.** They are measured on the tuning seasons, they replace assumed ones, and the bar's other parts are judged with them:
  - `roster.starter_share` is 0.65 (NBA) and 0.8 (WNBA);
  - `roster.min_gain` is 0.0 (NBA) and 0.2 (WNBA), now per league.
  - `dropRule`, `reviewRoster` and `teamReview` read the league's own.
  - The minimum gain also applies to the week unit, which was not judged.
- **The badges:**
  - The Moves keep "not yet validated", now linked to the rework of the swaps (#895).
  - The "Trade, don't drop" line gets its own badge, linked to #896.

## Consequences

- **A failing part is reworked or removed,** and nothing visible is removed without the owner's call:
  - **The swaps (#895):** require a gain beyond the rest-of-season value's measured error, so a swap inside the noise is not offered.
  - **The chips (#896):** drop the "trade, don't drop" line, or let a protected player be dropped when the gain clears that error.
- **The judged seasons are spent** for these parameters. A re-fit is judged from 2026-27 on.
- **Not tested here:**
  - the week unit and `roster.bench_size`;
  - points leagues;
  - the position check;
  - `roster.candidates`, which cannot change the first swap.
  - The locked seasons, NBA 2025-26 and WNBA 2026, are untouched.
- **#868 (Fit weights) does not touch the review.** The values carry #848's market prior, which merged before this ran.
