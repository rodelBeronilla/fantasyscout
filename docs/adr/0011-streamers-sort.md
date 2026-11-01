# 0011. Streamers sort

Date: 2026-10-30
Status: Accepted
Supersedes: the matching addenda of ADR 0003 (moved here on 2026-11-01, text unchanged)

## Context

How the Streamers page orders its candidates: by what a player adds to the week's category totals, chosen by replaying every Monday of each season. Written as an addendum to ADR 0003; its own record here, with the signals later tested against it in ADR 0012.

## Streamers sort by what a player adds to the week (2026-10-30)

The streamer signals notebook replays Streamers every Monday of each regular season. It ranks the players outside the rostered pool by each signal and scores them on what they add to the next seven days' category totals; a game not played adds nothing. On the latest season it compared each sort's top ten with the week's ten best pickups. The default sort, the minutes trend, found 1.9 of them in the WNBA and 0.9 in the NBA. Last-ten production times the team's games found 3.3 and 1.4. The page's Window value multiplied the last-ten z-score by games, and a z-score is measured from the pool's average: more games make a below-average player look worse. It ranked near zero in the WNBA.

`mart_streamers.last_10_production` is what an average game of the last ten adds to the category totals, in units of each category's spread over the season's pool. Counting stats add, turnovers subtract, and shooting adds its makes above the pool's percentage. It is the last-ten z-score plus a constant, so it ranks players the same way, but it stays positive for about 95% of them and so scales with games. Window value is now production times games in the window, plus each game's matchup. It is the default sort while games are scheduled. An 8-category league leaves the turnovers term out.
