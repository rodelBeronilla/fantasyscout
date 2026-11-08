# In-season usefulness scorecard

Date: 2026-11-08, refreshed the same day once the first scorecard's gaps (#815 to #823) had merged (#873). Scope: the eight in-season jobs a manager does; drafting and preparation are out of scope for now. Each job was walked end to end on FantasyScout (its code and its live pages) and compared with Yahoo Fantasy, ESPN Fantasy, Basketball Monster, Hashtag Basketball and League Winner Sports.

**How the comparison was made.** Competitors' free pages were walked live. Their paid features were judged from their own published help and feature pages, without logging in, and are marked unverified where only marketing copy describes them. None of the competitors document how their pages differ on a phone and a desktop, so digestibility is judged in depth for FantasyScout only.

The refresh walked them again. Yahoo's and ESPN's league pages, and Basketball Monster's member tools, need a login, so those are judged from help pages only.

**How a cell is scored.** Each cell is FantasyScout's standing against that platform: ahead, at par or behind. The refresh adds three rules:
- **Not yet validated (†).** A lead still behind a "Not yet validated" badge (the methodology, #751) scores at most at par against a platform that gives the same kind of answer. It can be ahead only of one that gives none.
- **Failed.** A lead that failed its backtest counts for nothing.
- **Two rows.** Where only an ESPN import gets the lead, the job has two rows: an ESPN import, and every other league (Yahoo through the bookmarklet, or built by hand).

| Job | Yahoo | ESPN | Basketball Monster | Hashtag | League Winner |
| --- | --- | --- | --- | --- | --- |
| 1. Today's lineup | Behind | Behind | Ahead | Ahead | Ahead |
| 2. This week's matchup, ESPN category league | At par | At par | At par† | Ahead† | Ahead† |
| 2. This week's matchup, other leagues | At par | At par | Behind | At par† | At par |
| 3. Waivers and streaming | Ahead | Ahead | At par† | At par† | At par† |
| 4. Trades | Ahead† | Ahead† | At par† | At par† | At par† |
| 5. Injuries and IL | At par | At par | At par | Ahead | At par |
| 6. State of the league, ESPN import | At par | At par | At par | At par | At par |
| 6. State of the league, other leagues | Behind | Behind | Behind | At par | Behind |
| 7. Your own team | Ahead | Ahead | Ahead | Ahead | Ahead |
| 8. Playoff push, ESPN category league | Ahead† | Ahead† | Ahead† | Ahead† | Ahead† |
| 8. Playoff push, other leagues | Ahead† | Ahead† | At par | Behind | Behind |

ESPN points leagues score as "other leagues" in jobs 2 and 8: no score so far and no playoff odds (#877).

## What moved, job by job

1. **Today's lineup: ahead of Basketball Monster (was at par).**
   - Today now leads with start, bench, check and out (#828). A questionable starter carries a check time half an hour before tip-off.
   - The evening report runs at 6:47 and 9:17 pm ET catch most late scratches (#829). GitHub starts scheduled runs late, though.
   - Basketball Monster's members get daily projections and no lineup call.
   - **Still behind the hosts:**
     - Yahoo and ESPN set the lineup in one tap (Start Active Players, Quick Lineup).
     - Yahoo pushes injury and news alerts. FantasyScout sends none (#876).
     - A player his team lists inactive, but who is not on the injury report, still gets "Start" (#878).
2. **This week's matchup: at par with Basketball Monster, and ahead of Hashtag and League Winner, for an ESPN category league (was behind, behind and at par).**
   - The week starts from ESPN's score so far and counts only the games each lineup starts (#830, #838).
   - It leads with the call and the category that swings it, and links to the streams that flip a category (#846).
   - **Held at par with the hosts:**
     - Once tonight's games tip, the projected final counts them twice: the score holds them, and so does the rest of the week from today (#875).
     - The weekly projection is not yet validated (#754).
   - **Other leagues:** the count of started games now reaches every league, so the row is at par with Hashtag's hand-ticked planner (was behind). They still have no score so far, and a Yahoo league picks its opponent by hand (#874).
3. **Waivers and streaming: unchanged.**
   - Pickups now leads with the top three adds, why, and the drop (#843). The matchup passes its losing categories in (#846).
   - The window value behind the top three is not yet validated (#762). So it stays at par with:
     - Basketball Monster's add and drop suggestions;
     - Hashtag's Waiver Machine;
     - League Winner Pro's nightly picks.
   - Yahoo and ESPN have no streaming tool.
4. **Trades: at par with Basketball Monster, Hashtag and League Winner (was ahead).**
   - The trade itself is unchanged. The verdict, the finder and the suggestions carry #756's badge.
   - Each of those three platforms gives the same kind of answer:
     - Trade Monster's simulation;
     - Hashtag's Trade Machine;
     - League Winner's free Trade Winner, which prices both sides and names the categories won and given up.
   - Yahoo's Trade Hub suggests partners but gives no two-sided verdict. ESPN documents no analyzer.
5. **Injuries and IL: unchanged.**
   - Who takes an out player's minutes now sits beside each of your out players, and each IL move comes with the pickup for its spot (#853). Its figure is not yet validated (#763).
   - League Winner's free injury report already has a "Takes his minutes" column for every out player.
   - Expected games missed, calibrated on past listings, is still ahead of Hashtag's injury database.
6. **State of the league: at par with League Winner for an ESPN import (was behind); behind most platforms for other leagues (was at par).**
   - **ESPN import:** the real standings (#852) lead My Team: place, record and games back.
   - **Power rankings failed in the NBA** (#755, ADR 0021). They fail at half way in 2023-24, and a tenth in for rotisserie in 2024-25 (#867). So they count for nothing. They pass in the WNBA.
   - **Other leagues:** these get only the projected table, whose order is the failed power rankings. That leaves them behind every platform that shows the real standings. The hosts show them to the same manager, and Basketball Monster and League Winner show them through a sync.
7. **Your own team: ahead of Basketball Monster and Hashtag (was at par).**
   - A head-to-head league's category win chances passed their backtest (ADR 0021). The tile lost its badge. None of the other platforms publishes a test of its team analysis.
   - Rotisserie chances keep theirs: a projection spread by the games left did not fix the first game day (#866, ADR 0022; next #898). So do:
     - the week's lineup (#759);
     - the roster review and Build your team (#757).
8. **Playoff push: ahead of Hashtag and League Winner for an ESPN category league (was behind).**
   - My Team leads with the odds of making the playoffs, your games in the playoff weeks, and one target (#859).
   - The odds beat the current standings out of sample but are not yet calibrated season by season (#872, ADR 0025). A share per tally did not fix it (#900, ADR 0028): pooled over seasons the slope is 0.90 to 1.02, but single seasons swing both ways (next #907). League Winner's free odds give the same kind of answer.
   - The playoff-week plan is factual and League Winner has none. Hashtag's free playoff schedule counts each NBA team's games, not your roster's in your league's weeks.
   - **Other leagues:**
     - The odds start every team level.
     - The playoff weeks are assumed to be the schedule's last, while most hosts end before the NBA's last week (#874).
     - That puts them behind Hashtag's host presets and League Winner's synced records.

**Where FantasyScout leads:**
- the week from the score so far, with the call and the streams for the categories at stake (ESPN category leagues);
- a head-to-head team's categories as win chances, tested out of sample;
- the playoff-week plan for your league's own weeks;
- expected games missed, calibrated on past injury listings;
- WNBA coverage;
- free throughout.

**Where it trails:**
- **Everything live is ESPN-only.** A Yahoo league gets no score so far, no real standings, odds from level records, and its opponent picked by hand (#874).
- **Between visits it is silent.** There are no alerts, and the lineup cannot be set from here (#876).
- **Most of the leads are untested.** Trades, Pickups' top three, the weekly projection and the playoff odds all carry the "Not yet validated" badge. The power rankings failed. The backtests in #751 decide which become real leads.

## The first scorecard's gaps: what shipped

| # | Gap | Shipped | Left |
| --- | --- | --- | --- |
| 1 | The league copy goes stale | #836: ESPN re-imports on each visit, sets this week's opponent and says when it last synced; Yahoo offers a re-sync after a day | Yahoo and hand-built leagues (#874); an open page never re-reads (#875) |
| 2 | No start/sit verdict; late scratches missed | #828 verdict; #829 two late-evening report runs | Inactive list and ESPN's IR slot (#878); alerts (#876) |
| 3 | The matchup ignores the score so far | #830 started games only; #838 score so far for ESPN category leagues | Tonight's games counted twice (#875); points leagues (#877); other leagues (#874) |
| 4 | The matchup does not lead into streaming | #846 | – |
| 5 | Pickups puts filters before answers | #843 | Validation (#762) |
| 6 | No word on who takes the minutes | #853 | Alerts (#876); validation (#763) |
| 7 | No playoff odds or playoff-week plan | #859 | Other leagues' weeks and records (#874); points leagues (#877); validation (#872) |
| 8 | No real standings | #852 | Other leagues (#874) |
| 9 | Thin per-player news notes | #860; #879: a call first, a rerun after each build, kept and marked when an input changes, withdrawn when contradicted, on the player page and the Board, missed runs on Data Health | Validation of the calls |

## Gaps, ranked by how often the job comes up times how far behind

| # | Gap | Jobs | How often | How far | Issue |
| --- | --- | --- | --- | --- | --- |
| 1 | Yahoo and hand-built leagues get none of the live parts: score so far, standings, opponent, playoff weeks | 2, 6, 8 | daily | large | #874 |
| 2 | The evening matchup counts tonight's games twice; an open page never re-reads the league | 2, 3 | daily mid-week | medium | #875 |
| 3 | No alerts between visits | 1, 5 | a few times a week | large | #876 |
| 4 | ESPN points leagues get no score so far and no playoff odds | 2, 8 | daily, in a points league | medium | #877 |
| 5 | Today's start call misses the team's inactive list and ESPN's IR slot | 1 | daily | small | #878 |
| 6 | Player notes vanish at a late change and show on few pages | all | daily | small | #879 |

The "Not yet validated" badges are not listed as gaps. Each has its own issue under #751, and passing one is what turns a † at par into a lead.

**The rule for every fix** is unchanged: lead with what to do now and why, with the evidence one click down (the decision of 2026-11-08).

## Qualitative data on other platforms

- **Yahoo:** player notes and push alerts for injury status, roster changes and news.
- **ESPN:** short unsourced blurbs beside rostered-share changes, and weekly columns.
- **Basketball Monster:** a raw status feed linking to the posts behind it.
- **Hashtag Basketball:** next to no news.
- **League Winner:** a newsroom framed by fantasy impact, with an add, hold or drop call per player (about half of it Pro), and a one-line note per waiver candidate.

FantasyScout carries:
- ESPN headlines, news flags and injury notes;
- the official injury reports and lineup tags;
- add and drop trends;
- weekly AI notes whose every number is traced;
- a one-line note for each flagged player, every number and quote traced (#860).

Those player notes come from the home server's local model, for flagged players in the board's top 200 (NBA) or 120 (WNBA): every one once a day, and again after each build for those whose listing or headline changed, so a late scratch gets a line before tip-off (#879). Each leads with its call (start, sit, add, drop, hold or watch). A note whose inputs changed stays, saying what changed; one the listing now contradicts is withdrawn, saying so. The qualitative-signals epic (#812) covers their inputs.
