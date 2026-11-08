# 0019. One value scale

Date: 2026-11-07
Status: Accepted (supersedes the pool rule in ADR 0003)

## Context

The methodology overhaul (#751) needs every number to be comparable with the one it is checked against. Before this change the site measured value in eight places, on five pools and two zero points:

- **The board's projected value** used the fantasy league's pool: teams x roster spots (156 NBA, 100 WNBA), chosen in two passes. Its zero was replacement level.
- **The windows** were the season, the last twenty and last ten games, plus single games and the floor and ceiling. They used the top 180 NBA or 90 WNBA players by minutes in that window, hardcoded in SQL. Each window had its own means and spreads, and its zero was the pool's average. In the WNBA the season pool (90) was smaller than the rostered pool (100).
- **Playoff games** counted in every box-score window. Play-in games were left out only because they are never ingested.

So the site compared numbers measured on different scales:

- buy low, sell high subtracted the projection from last-ten form;
- the Pickups trend subtracted last season's value from the last ten games;
- the floor and ceiling sat next to a value with a different zero.

Part of every such gap was the change of scale, not the player.

## Decision

**One scale per league and season** (`int_value_scale`). Each scale has:

- **The pool:** the fantasy league's own (`fantasy.<league>.teams` x `roster_spots`), chosen in two passes. Pass one ranks by minutes; pass two ranks by pass-one value. The pool is never so large that no one is left to set replacement level.
- **Its moments:** the means and spreads of the counting categories, the shooting percentages, and the spread of the shooting impact.
- **The replacement level:** each category's average score over the `teams` players after the pool.

**Which lines set it.** The season the board values uses the board's projection: a per-game expectation, already shrunk toward replacement level, which ranks as it stands. Every other season uses its regular-season lines. Those are not shrunk, so before they rank or set replacement level they are shrunk the way the projection is: by `prior_games` games (3 NBA, 5 WNBA) at the level of the players just outside the pool by minutes. That band is the one the projection's own prior comes from. A player with two great or two awful games then lands near replacement level, not in the pool or the replacement band.

A review found the first version wrong: ranking a past season by its total (per game times games) let call-ups with a few awful games outrank 70-game regulars a little below the pool's mean. The cause is that a small negative total beats a large one. `value_scale_shrinks_a_past_season_before_it_ranks` pins the fix.

**Everything is scored on it** (`macros/value_scale.sql`):

- the board's projected value;
- the season, last-twenty and last-ten lines (`mart_category_zscores`);
- every single game (`int_player_game_value`), and so the floor and ceiling;
- the previous season's line in the Pickups trend, scored on this season's scale.

Each of these is value per game above the league's replacement level, in the same units. A game's score is linear in its numbers, so a player's mean game value is their season value. `assert_one_value_scale` checks this on every build. It also checks that the board's replacement band averages zero and that no playoff game is valued.

**Regular season only.** `int_player_window_lines` reads regular-season games only (the third character of the game id is 2). That makes it the source for the projection's per-minute rates and minutes as well. Playoff games no longer move a player's form or a past season's line.

**Last-ten production keeps its zero.** Pickups ranks a streamer by production times games (ADR 0011), so its zero stays at no production; a game always adds. Its units are now the scale's spreads.

**The web keeps the published scale.** A league of another size moves the replacement level in the browser (`league-value.ts`). The offset is measured once on the projection and applied to every window, so the last ten games stay comparable with the projection there too.

## Consequences

- At the default league size, the board's value is unchanged apart from the projection now ignoring playoff games. The windows change meaning: their zero is replacement level, not the top 180's average. A player's last ten games can now be read against their projection directly.
- The hardcoded 180 and 90 are gone from the lakehouse. The pool size has one source: the `fantasy` var, which a league's own settings override in the browser. `notebooks/replay.py` re-implemented the old windows for the notebook backtests until #776 retired it for the point-in-time harness (ADR 0018). The notebooks that measure a game's value now read this scale from the build (`notebooks/boxscore.py`).
- **Real lines are measured in the projection's units.** In the season the board values, the spreads come from projected lines, which are narrower than real box-score lines because a projection is shrunk. Measured in those units, a real season, last-ten or single-game value spreads wider than the projection: good players read higher and weak ones lower. That is the cost of one scale. Last ten minus projection carries it, and #769 checks buy low, sell high (#758) against it. Before, each window had its own spread, but that made the difference between two windows meaningless.
- A window's category is never null now. A line with no attempts scores 0 for shooting, less replacement level, where it used to be null. A missing box-score number in a game played counts as zero in the lines and the game values alike, so `assert_one_value_scale` holds exactly.
- The backtests of ADR 0009 were run with playoff games in the lines. The walk-forward harness (#769) re-checks the projection on regular-season lines (#754).
- `in_pool` is no longer a column of `mart_category_zscores`. Pool membership belongs to the board (`mart_board.in_pool`).
