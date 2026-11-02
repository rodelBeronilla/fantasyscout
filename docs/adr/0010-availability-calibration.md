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
- **Status:** the official report's status for the next game, else ESPN's listing in the report's words (day-to-day reads as questionable).
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
