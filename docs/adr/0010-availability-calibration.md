# 0010. Availability calibration

Date: 2026-10-30
Status: Accepted
Moved from: ADR 0003, its matching addenda (moved here on 2026-11-01, text unchanged)

## Context

How the board's rest-of-season value charges a listed player for the games they are expected to miss: calibrated on the leagues' past official injury listings rather than fixed charges per status, and later factored into its own table. Written as addenda to ADR 0003 as it was decided; one subject, here.

## Availability calibrated on past official injury listings (2026-10-30)

The board's rest-of-season value scales by an availability multiplier: the share of the remaining regular-season games the player is expected to play. It charged fixed amounts per ESPN status:
- out with a return date: the games before it;
- out without a date: every game left;
- doubtful: 0.75 of a game;
- questionable: 0.5;
- day-to-day: 0.25.

The game context notebook found that players who miss a game go on to miss 3 to 5 more on average, so these charges were never checked against outcomes.

The leagues keep every official injury report on their host, the NBA's back to 2023-24, and `fs-ingest land reports --history` lands the 5 pm Eastern report for each past day. `gold.fct_official_listing` links each listing before a regular-season game to the game and the player, and counts the team's games until the player next played. NBA 2024-25, injury listings only:

| Status | Listings | Missed the game | Games missed, mean | Median | Old charge |
|---|---|---|---|---|---|
| Out | 5,635 | 100% | 12.6 | 7 | every game left, if no return date |
| Doubtful | 169 | 98% | 4.7 | 2 | 0.75 |
| Questionable | 1,512 | 50% | 1.6 | 1 | 0.5 (day-to-day 0.25) |
| Probable | 548 | 6% | 0.2 | 0 | 0 |

The fixed charges were off in both directions. Doubtful and questionable listings were undercharged several times over. An out listing without a date erased the whole season, where the typical absence is about two weeks.

The multiplier now charges a listed player the average, over past injury listings with the same status, of the games then missed, capped at the games the team has left. Rules:
- **Status:** the official report's status for the next game, else ESPN's listing in the report's words (day-to-day reads as questionable). An official Available reads as Probable, the mildest status listed, rather than falling through to ESPN's day-to-day (#388).
- **Return date:** ESPN's expected return date, when given for a player ruled out, still counts the games before it.
- **Out for the season:** an ESPN note that the player is out for the season counts every game.
- **Which league's history:** a league uses its own listings once it has 300 for the status. Until then the NBA's apply; the WNBA archive only starts in 2026.
- **No history:** without any listing history the old charges apply.

The averages update with every build as the daily reports add listings. The game context notebook publishes the table per league.

The calibration matches the reason as well as the status. An official Out for rest is averaged over past rest listings (NBA 2024-25: 1.2 games), not injury listings (12.6). The same holds for a G League assignment, personal reasons or a suspension. ESPN's listings are injuries.

## The availability calibration is its own table (2026-11-01)

The board computed the games a listed player is expected to miss by joining every board player who has a status against every past `fct_official_listing` row with the same status and reason, with the 300-listing league switch written into the join condition, where no test could reach it; the game context notebook recomputed the same averages from the listings on its own.

Decisions:

- `gold.fct_status_calibration` is the histogram: one row per league served, status, reason group and number of games missed, with the past listings that missed exactly that many, `source_league` saying whose listings they are and `own_listings` the count the switch is made on. The threshold is a project variable, `calibration_min_listings` (300), rather than a literal in the board.
- The board joins a listed player to the rows for their league, status and reason, caps each `games_missed` at the games the team has left and takes the listings-weighted mean. Every board value is unchanged (the weighted mean of a histogram is the mean of the listings; the CI sample is byte-identical), and the join is players × histogram rows rather than players × listings.
- The notebook reads the histogram and shows what the board uses: for the WNBA, the NBA's rows and the fact that they are borrowed, rather than the WNBA's own handful, which the board does not read yet.
- Unit tests: `status_calibration_falls_back_to_the_nba_until_a_league_has_enough` pins the switch (a league under 300 reads the NBA's rows with its own count beside them; a league at 300 reads its own; the NBA, its own fallback, gets no row for a reason it has never listed), and the board's availability test gains a listing whose games missed exceed the games left, to pin the cap.

## Addendum (2026-11-02): when the WNBA reads its own listings

A league reads its own official listings for a status once it has 300 of them; until then the NBA's apply. The WNBA's archive starts in 2026; the 2026-11-02 audit put the first status past 300 around the middle of the 2027 season, and the rarer statuses later. The switch is automatic; the game context notebook's fact marks each status still read from the NBA ("n 627, NBA's") until then (#492).

## Addendum (2026-11-03): teams with nothing to play for rest their regulars (#494)

The board tagged a team with nothing left to play for (`fct_team_stakes.rest_risk`: clinched or eliminated with 10 or fewer games left in the NBA, 6 in the WNBA) but charged nothing for it. Notebook 03 now tests the belief point in time. `fct_team_stakes` is a snapshot, so the notebook rebuilds the standings before each of a team's last games from the results. A team counts as clinched when its wins are beyond what the first team outside a guaranteed place can still reach (top 6 of the conference in the NBA, top 8 in the WNBA). It counts as eliminated when it cannot reach the wins of the last place in the race (10th in the conference with the play-in, 8th in the WNBA). Ties and tiebreakers are ignored, so both calls are conservative. Regulars, meaning 20+ games and 28+ minutes a game before, were compared with regulars on teams still racing in the same stretch, with a bootstrap over team-seasons (run 41565914043, the published build of 2026-11-02):

| Last stretch | NBA | WNBA |
| --- | --- | --- |
| Regulars sat out, nothing to play for / racing | 50.7% / 21.7% | 10.6% / 8.1% |
| Difference | +29.0 pts (22.2 to 36.4) | +2.5 pts (-2.9 to +7.1) |
| Minutes when they played | -1.04 (-1.74 to -0.19) | -1.61 (-2.54 to -0.83) |
| Team-seasons with nothing to play for | 58 | 91 |

The bar set in advance was 5 points or more with the interval clear of zero. The NBA clears it and the WNBA does not. So the board now charges an NBA regular (28+ projected minutes) on a `rest_risk` team 0.29 of the games left: the availability multiplier, and with it `ros_factor` and value for the rest of the season, keeps 0.71 (`fantasy_rest_risk` in `dbt_project.yml`). The WNBA's setting is 0. The notebook re-runs the comparison on every build and publishes it as a fact, so the charge can be revisited as seasons add up.
