# 0026. The matchup card's chances, judged week by week; its too-close band not validated

Date: 2026-11-08
Status: Accepted

## Context

The week's matchup card (#490) calls each category won, lost or too close.

- **Today's rule:** too close means a margin within 5% of the larger total (`matchup.closeness` 0.05). Nothing measured it, and 5% means very different things in points and in FG%.
- **#869 asked for two things:** a chance per category from measured weekly error, and a band derived from it, each judged out of sample on the card's own projection.

The bar was declared on #869 before any run.

## Options considered

- **Reuse the standings model's weekly chances (ADR 0021).** The card does not read them: it projects from each lineup's games in raw units.
- **Fit a chance on the card's own projection (chosen).** Then fit a band by a decision replay of what the label drives: the need chips and the stream.

## Decision

**The chance:** Φ(margin ÷ s). It lives in `web/src/lib/matchup.ts` and is mirrored in `ops/matchup.py`, pinned by `tests/fixtures/matchup_parity.json`.

- **Counting categories:** s = σ √(games left, both sides).
- **FG% and FT%:** s = σ √(G₁ ÷ A₁² + G₂ ÷ A₂²), so a percentage settles as the shots add up.
- **σ** is `matchup.game_spread`, per league and category.

**The harness** is `ops.closeness_backtest`, on the Backtest workflow's `closeness` input.

- **The builds:** a point-in-time build on every week's first day (ADR 0018).
- **The leagues:** #755's leagues, drafted afresh each week. Every pair meets.
- **The card's projection:** the projected line times the team's games that week, a player listed out or doubtful counting for none.
- **What happened:** the week's real box scores.

**Fitted on the tuning seasons:**

- **NBA:** runs 42494531714, 42494538368 and 42494544319, 71 weeks.
- **WNBA:** runs 42494550191, 42494555493 and 42494560975, 51 weeks.

The results:

- **`matchup.game_spread`:** each category's log loss fell to 0.530 to 0.669, against a coin's 0.693.
  - The NBA's spreads are larger than one game's noise, at 17.3 points a player-game, since they carry what the projection misses over a week.
- **`matchup.closeness`,** by the stream replay: **0 (NBA)** and **0.40 (WNBA), the grid's edge.**
  - The replay is nearly flat: categories won a week moved by about 0.009 across the whole grid in each league.
  - It points opposite ways in the two leagues.

**Judged:** NBA 2023-24 (run 42503278616), NBA 2024-25 (42503283927), WNBA 2024 (42503289028) and WNBA 2025 (42503294592). Brier gaps are positive when the card is better.

| Season | vs coin | vs naive | Slope |
| --- | --- | --- | --- |
| NBA 2023-24 | +0.0425 (+0.0376 to +0.0461) | +0.0122 (+0.0096 to +0.0153) | 0.99 |
| NBA 2024-25 | +0.0426 (+0.0374 to +0.0467) | +0.0096 (+0.0074 to +0.0121) | 0.99 |
| WNBA 2024 | +0.0352 (+0.0265 to +0.0437) | +0.0187 (+0.0136 to +0.0232) | 0.97 |
| WNBA 2025 | +0.0337 (+0.0285 to +0.0378) | +0.0197 (+0.0144 to +0.0264) | 0.82 |

- **The chances pass in every season.** They beat a coin flip and the naive manager (season-so-far lines) with every interval clear of zero, and they are calibrated. A projected leader at 60% to 70% won 63.5% to 65.3% of the time.
- **The band fails.**
  - In NBA 2024-25 the fitted band (0, no band) is worse than the share rule in the stream replay: −0.0365 (−0.0585 to −0.0152) categories a week.
  - In WNBA 2025 the fitted band (0.40) is worse than no band: −0.0468 (−0.0949 to −0.0025).
  - At 0.40, 94% of the categories would read as too close.

**The declared rule for the band was degenerate.** The replay rewards a wider band because more categories become stream targets, and the pick drifts toward the best player overall. It measures the need-chip decision, not what a coin flip is. So the band is not validated by this work. That is a fail and a rework (#902), not a new bar.

**What ships:**

- **The chances** decide the calls, and the fitted spreads are in the registry.
  - The swing category and the need chips are ordered by how near a coin flip each category is, not by share, since a share is not comparable across categories.
  - The card keeps its own badge for the weekly projection (#754), which is a separate test.
- **The band keeps today's value,** 0.05 in both leagues, read as a chance within 5 points of 50%. It is marked assumed.
  - "Too close" carries its own "not yet validated" badge, linked to #902.
  - The card names the band ("a 45% to 55% chance") in place of "within 5%".

## Consequences

- **#902 holds two reworks:**
  - need chips targeting by chance-weighted value, or all categories, since the replay shows narrow targeting does not help;
  - a decision-free definition of the label: calibrated "within X of 50%" bands chosen from how managers act on them.
- **The chances' judged seasons are now spent** for `matchup.game_spread`, and the locked seasons are untouched.
- **Not tested:**
  - a card read mid-week from the score so far: the simulated weeks have weekly totals only, so the spread's fall with the games left is assumed;
  - lineup slots: every player is active, as in #755.
