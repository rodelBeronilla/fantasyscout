# 0015. A standings model for categories leagues

Date: 2026-11-03
Status: Accepted

## Context

In a categories league the board's Fit weighted each category by the manager's own totals: the weakest third ×1.5, the strongest third ×0.5 (`fitWeights`). That ranks a team's categories against each other, not against the league. A category where the team is seventh of eight could read as strong because its raw total is high, and a category the team leads by a mile still counted. The Trade page judged trades on value above replacement alone. Its category table showed rank changes, but the verdict did not use them (#662, #663).

What decides a categories league is the chance of beating the other teams, category by category. That chance depends on two things: the gap between the teams' totals, and how much the category moves from game to game. A two-steal gap means little over one week; a two-point gap means more.

## Options considered

1. **Keep ranking the team's own totals.** Simple, but it does not see the league. A manager punting three categories saw players who help nowhere rated as fits.
2. **Rank against the league's teams (integer ranks).** This is what the Trade page's rank column did. It is coarse: a gain either crosses a rival's total or counts for nothing. And it treats a weekly head-to-head matchup as if totals were certain.
3. **A probability model of the standings (chosen).** For each category and each rival, the chance of finishing ahead is Φ(gap ÷ spread). A head-to-head team then expects to win the sum of those chances in a week against an average opponent; a rotisserie team expects that share of the teams beaten. A category's Fit weight is the derivative: how much one more unit raises that chance, averaged over the rivals and scaled to average 1.

## Decision

Option 3, in `web/src/lib/standings.ts`.

- **Totals.** A team's total in a category is the sum, over its active players (not on the IL), of each player's per-game value above replacement times `availability_multiplier`, the share of the games left the player is expected to play. Only the kept categories count, after the league's punts (#661).
- **Spread.** One game's standard deviation of a player's output in each category, in the board's z units, was measured on the lakehouse with the "Query the lakehouse" workflow on 2026-11-03:
  - Method: within-player variance over games against the spread of per-game averages, for the 180 NBA or 90 WNBA players with the most minutes and 20 games or more.
  - Results: NBA points 1.14, rebounds 1.10, assists 1.03, steals 3.12, blocks 1.77, threes 1.61, turnovers 1.63, FG% 2.85, FT% 2.67 (mean of 2023-24 to 2025-26; each season within about 0.2 of the mean). The WNBA's are close (2022 to 2026).
  - Weekly spread: the spread of the gap between two teams of *n* active players over a week of *g* games each is `game spread × √(2n ÷ g)`, with *g* = 3.3 games a week in the NBA and 2.6 in the WNBA.
  - Rotisserie: uses the games left in the season instead of a week, plus a projection error of 0.3 z per player per category. **The projection error is an assumption, not a measurement**; calibrating it is follow-up work.
- **Rivals.** Every other team with at least half its roster entered, so a team the manager has only started to fill in does not count as an easy win. With no rival, Fit falls back to the old weights.
- **Fit.** On the board, the This-week unit of a head-to-head league with an opponent set keeps the matchup weights (#490). Otherwise Fit uses the standings weights, and the League bar names the three kept categories the team is least likely to win.

## Consequences

- A category the team wins or loses against everyone by a wide margin weighs almost nothing in Fit. A punted category is out entirely. Close categories dominate, as they do in a real league.
- Steals and the percentages weigh less per unit than their raw z-scores suggest, because a week's games swing them so much.
- The spreads are constants in the code. They held steady across the three NBA seasons measured. A new measurement replaces them in a PR that records the query, as this one does.
- The Trade page's verdict and suggestions read the same model (#663), so the board and the Trade page agree on what helps a team.
