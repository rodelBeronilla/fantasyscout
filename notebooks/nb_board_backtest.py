"""01_board_backtest: does the board's projection rank the players who go on to produce?"""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Board backtest: does the projection find the players who go on to produce?

**The question.** Every draft pick and most in-season adds lean on the board's ranking. The
board does more than average past seasons: it blends production per minute and minutes per game
with recency weights, discounts a role on another team, follows the last five games in season,
cuts the minutes of a player coming back from an absence, starts every player from a few games
of a replacement-level line and scales by how often the player plays (ADR 0003). That machinery is only worth having if it ranks the players who go on
to produce better than what a manager could do with no model: last season's per-game numbers,
or this season's so far.

**What this notebook does.** It replays the board as a manager would have seen it before each
regular season and a tenth, a quarter and half way through it, using only the games before that
day, and compares its ranking with what the players then produced over the rest of the regular
season.""",
    ),
    (
        "md",
        """## Method

- **Replay.** `replay.py` re-implements `mart_player_projection` and `mart_board` point in time
  from `fct_player_game`, reading every setting from `dbt/dbt_project.yml`. The last cell checks
  the replay against this build's own projection.
- **Who is on the board.** The board lists rostered players. Before a season the roster is
  everyone listed in a box score (played or not) in the first seven days, which is the opening
  roster a manager knows before tip-off. In season it is everyone listed in the 21 days before.
  A player the board cannot project (a rookie before a first game) counts as replacement level,
  and every method is scored on the same players.
- **Targets.** The rest of the regular season is scored like the board scores projections:
  two pool passes over the realised pool, with replacement level subtracted. *Value counting
  missed games as zero* (value per game times the share of the team's remaining games played) is
  defined for every listed player, so nothing is conditioned on who went on to play. *Value per
  game* needs games to exist: it is measured for players with at least a fifth of the team's
  remaining games (and three).
- **Baselines.** Last season's per-game value (regular season, no prior) and the season to date
  only (from a tenth of the way in). The board is compared on the per-game target with its value
  per game and on the total target with its season value.
- **Metrics.** Top-N hit rate (the share of the predicted top 50 NBA / top 30 WNBA who finish in
  the realised top N), Spearman rank correlation, mean absolute error, and capture (realised value
  of the predicted top N over that of the realised top N). Intervals are 95% player-bootstrap
  intervals: players are resampled, the same draw across checkpoints.
- **In and out of sample.** WNBA 2021 to 2026 and NBA 2024-25 and 2025-26 were replayed to choose
  the settings (ADR 0003), so results there are in-sample. Earlier seasons are out-of-sample
  (NBA 2023-24 and WNBA 2018 have no season before them, so they start a tenth of the way in).
  The in-season minutes blend was fitted on next-ten-game minutes over all seasons, so no season
  is fully untouched by it. Two later sections test single pieces with their own protocol: the
  return ramp on next-five and next-ten-game minutes, and an aging curve before the season.""",
    ),
    setup(),
    (
        "code",
        """import replay as rp

SETTINGS = rp.load_settings()
cols = ', '.join(rp.GAME_COLUMNS)
replays = {}
for lg in LEAGUES:
    g = con.sql(f"select {cols} from fct_player_game where league = '{lg}'").df()
    if len(g):
        replays[lg] = rp.Replay(g, SETTINGS[lg])


def complete_seasons(r):
    \"\"\"Seasons whose regular season is over: its playoffs have started or a later season exists.\"\"\"
    seasons = r.seasons()
    playoffs = set(r.games.loc[~r.games['regular'], 'season'])
    return [s for i, s in enumerate(seasons) if s in playoffs or i < len(seasons) - 1]


pd.DataFrame([{'league': LABEL[lg], 'pool_size': s.pool_size, **{k: v for k, v in vars(s).items() if k != 'league'}}
              for lg, s in SETTINGS.items()])""",
    ),
    (
        "code",
        """METHODS = {'board': 'Board', 'last_season': 'Last season', 'to_date': 'Season to date'}
records, players = [], []
frames = {lg: [] for lg in LEAGUES}
for lg, r in replays.items():
    g = r.games
    for season in complete_seasons(r):
        earlier = [s for s in r.seasons() if s < season]
        sample = 'in-sample' if rp.is_in_sample(lg, season) else 'out-of-sample'
        for label, day in r.checkpoints(season):
            pre = label == 'preseason'
            roster = r.roster_at(season, day, preseason=pre)
            board = r.board(day, roster, in_season=not pre, complete_seasons=earlier)
            real = r.realised(season, day, roster)
            ids = real.index
            pred = {}
            if len(board):
                pred['board'] = (board['value_per_game'].reindex(ids).fillna(0).to_numpy(),
                                 board['value_total'].reindex(ids).fillna(0).to_numpy())
            if earlier:
                last = rp.baseline(r, g[(g['season'] == earlier[-1]) & g['regular']], roster)
                last = last.reindex(ids).fillna(0).to_numpy()
                pred['last_season'] = (last, last)
            if not pre:
                to_date = rp.baseline(r, g[(g['season'] == season) & g['regular'] & (g['game_date'] < day)], roster)
                to_date = to_date.reindex(ids).fillna(0).to_numpy()
                pred['to_date'] = (to_date, to_date)
            target = {'value_pg': real['value_pg'].to_numpy(), 'eligible': real['eligible'].to_numpy(),
                      'value_total': real['value_total'].to_numpy()}
            for method, (p_pg, p_total) in pred.items():
                records.append({'league': lg, 'season': season, 'checkpoint': label, 'date': day.date(),
                                'sample': sample, 'method': method, 'players': len(ids),
                                **rp.evaluate(p_pg, p_total, target['value_pg'], target['eligible'],
                                              target['value_total'], rp.TOP_N[lg])})
            frames[lg].append({'season': season, 'checkpoint': label, 'sample': sample,
                               'player_id': ids.to_numpy(), 'pred': pred, **target})
            if len(board):
                players.append(pd.DataFrame({
                    'league': lg, 'season': season, 'checkpoint': label, 'sample': sample,
                    'pred_pg': board['value_per_game'].reindex(ids), 'pred_total': board['value_total'].reindex(ids),
                    'pred_share': board['games_share'].reindex(ids), 'real_pg': real['value_pg'],
                    'eligible': real['eligible'], 'real_total': real['value_total'], 'real_share': real['share'],
                    'team_games_left': real['team_games_left']}))
results = pd.DataFrame(records)
players = pd.concat(players) if players else pd.DataFrame()
CHECKPOINT_ORDER = [label for label, _ in rp.CHECKPOINTS]
if len(results):
    print(f"{results[['league', 'season', 'checkpoint']].drop_duplicates().shape[0]} checkpoints, "
          f"{len(players):,} player-checkpoints on the board")
    display(results.pivot_table(index=['league', 'sample', 'season'], columns='method', values='top_total', aggfunc='mean').round(3))
else:
    print('No finished regular season to replay in this build.')""",
    ),
    (
        "md",
        """## How each method does, with intervals

Means over checkpoints. `top_total` and `spearman_total` are against value counting missed games
as zero; `top_pg`, `spearman_pg` and `mae_pg` against value per game; `capture` is the share of
the best possible top-N value the predicted top N delivered.""",
    ),
    (
        "code",
        """METRICS = ['top_total', 'top_pg', 'spearman_total', 'spearman_pg', 'mae_pg', 'capture']
boot = {lg: rp.bootstrap(frames[lg], rp.TOP_N[lg], reps=200) for lg in LEAGUES if frames[lg]}
meta = {lg: pd.DataFrame([{'frame': k, 'sample': f['sample'], 'checkpoint': f['checkpoint']}
                          for k, f in enumerate(frames[lg])]) for lg in boot}


def basic_interval(estimate, replicates):
    \"\"\"The basic (reverse percentile) bootstrap interval: resampling players with duplicates shifts
    a top-N count, and reflecting the quantiles around the estimate corrects that shift.\"\"\"
    lo, hi = np.nanquantile(replicates, [0.025, 0.975]) if len(replicates) else (np.nan, np.nan)
    return 2 * estimate - hi, 2 * estimate - lo


def subset(frame, sample):
    return frame if sample == 'all' else frame[frame['sample'] == sample]


summary_rows, gap_rows = [], []
for lg, b in boot.items():
    b = b.merge(meta[lg], on='frame')
    point = results[results['league'] == lg]
    for sample in ['out-of-sample', 'in-sample', 'all']:
        sp, sb = subset(point, sample), subset(b, sample)
        for method in METHODS:
            pm = sp[sp['method'] == method]
            if pm.empty:
                continue
            reps = sb[sb['method'] == method].groupby('rep')[METRICS].mean()
            row = {'league': lg, 'sample': sample, 'method': method, 'checkpoints': len(pm)}
            for m in METRICS:
                row[m] = pm[m].mean()
                row[m + '_lo'], row[m + '_hi'] = basic_interval(row[m], reps[m])
            summary_rows.append(row)
        # the board against each baseline on the checkpoints both cover
        for other in ['last_season', 'to_date']:
            for m in ['top_total', 'spearman_total', 'top_pg']:
                wide = sb.pivot_table(index=['rep', 'frame'], columns='method', values=m)
                if 'board' not in wide or other not in wide:
                    continue
                both = wide.dropna(subset=['board', other])
                if both.empty:
                    continue
                d = (both['board'] - both[other]).groupby('rep').mean()
                pw = sp.pivot_table(index=['season', 'checkpoint'], columns='method', values=m).dropna(subset=['board', other])
                gap = (pw['board'] - pw[other]).mean()
                lo, hi = basic_interval(gap, d)
                gap_rows.append({'league': lg, 'sample': sample, 'against': other, 'metric': m,
                                 'gap': gap, 'lo': lo, 'hi': hi, 'checkpoints': len(pw)})
summary = pd.DataFrame(summary_rows)
gaps = pd.DataFrame(gap_rows)
if len(summary):
    show = summary[['league', 'sample', 'method', 'checkpoints'] + METRICS].round(3)
    display(show)
    display(gaps.round(3))""",
    ),
    (
        "code",
        """if len(results):
    fig, axes = plt.subplots(1, len(replays), figsize=(6 * len(replays), 4), squeeze=False)
    styles = {'board': '-', 'last_season': '--', 'to_date': ':'}
    for ax, lg in zip(axes[0], replays, strict=False):
        part = results[results['league'] == lg]
        for method, label in METHODS.items():
            line = part[part['method'] == method].groupby('checkpoint')['top_total'].mean().reindex(CHECKPOINT_ORDER)
            ax.plot(CHECKPOINT_ORDER, line.to_numpy(), styles[method], marker='o', color=COLOR[lg], label=label)
        ax.set_ylim(0, 1)
        ax.set_ylabel(f'Share of the top {rp.TOP_N[lg]} found')
        ax.set_title(f'{LABEL[lg]}: top-{rp.TOP_N[lg]} hit rate, missed games as zero')
        ax.legend()
    plt.tight_layout()
    plt.show()""",
    ),
    (
        "md",
        """## Reliability and games played

A ranking can be right while its values are not. Grouping the board's players by decile of
predicted season value shows whether a predicted gap between two players turns into a realised
gap of the same size: a slope of realised on predicted below one means the board spreads players
too far apart. The slope is fitted on the players the board values above replacement. Below
replacement the board leaves a value unscaled by games, since a missed game from a player not
worth rostering costs nothing, while the target counts a missed game as zero. Fitted over every
listed player, the slope mixes the two conventions: most NBA listings are below replacement and
play little, so their realised values shrink toward zero and the slope falls (ADR 0003, the
value spread addendum). Per game, against players with enough games, the two sides are on one
footing too. The games share is the board's guess of the share of team games a player plays;
here it is set against the share of the remaining games they did play.""",
    ),
    (
        "code",
        """def fit_slope(x, y):
    \"\"\"Least-squares slope of y on x (NaN with too few pairs or no spread).\"\"\"
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    ok = np.isfinite(x) & np.isfinite(y)
    return float(np.polyfit(x[ok], y[ok], 1)[0]) if ok.sum() >= 10 and np.ptp(x[ok]) > 0 else np.nan


reliability, calibration = {}, {}
if len(players):
    fig, axes = plt.subplots(2, len(replays), figsize=(6 * len(replays), 8), squeeze=False)
    for i, lg in enumerate(replays):
        p = players[(players['league'] == lg) & players['pred_total'].notna()].copy()
        if len(p) < 50:
            continue
        p['decile'] = pd.qcut(p['pred_total'].rank(method='first'), 10, labels=False) + 1
        dec = p.groupby('decile')[['pred_total', 'real_total']].mean()
        slopes = []
        for sample, q in [*p.groupby('sample'), ('all', p)]:
            above, per_game = q[q['pred_total'] > 0], q[q['eligible'].astype(bool)]
            slopes.append({'sample': sample, 'players': len(q),
                           'above replacement': fit_slope(above['pred_total'], above['real_total']),
                           'per game': fit_slope(per_game['pred_pg'], per_game['real_pg']),
                           'every listed player': fit_slope(q['pred_total'], q['real_total'])})
        slope = pd.DataFrame(slopes).set_index('sample')
        reliability[lg] = {'deciles': dec, 'slope': slope}
        ax = axes[0][i]
        ax.plot(dec['pred_total'], dec['real_total'], marker='o', color=COLOR[lg])
        lim = [min(dec.min()), max(dec.max())]
        ax.plot(lim, lim, color='grey', lw=1, ls='--')
        ax.set_xlabel('Predicted season value (per game, games share applied)')
        ax.set_ylabel('Realised, missed games as zero')
        ax.set_title(f"{LABEL[lg]}: reliability by decile (slope above replacement {slope.loc['all', 'above replacement']:.2f})")
        s = p[p['pred_share'].notna() & (p['team_games_left'] >= 5)].copy()
        s['decile'] = pd.qcut(s['pred_share'].rank(method='first'), 10, labels=False) + 1
        sd = s.groupby('decile')[['pred_share', 'real_share']].mean()
        calibration[lg] = {'deciles': sd, 'pred': s['pred_share'].mean(), 'real': s['real_share'].mean(),
                           'corr': s[['pred_share', 'real_share']].corr().iloc[0, 1],
                           'mae': (s['pred_share'] - s['real_share']).abs().mean(),
                           'mae_flat': (s['real_share'].mean() - s['real_share']).abs().mean()}
        ax = axes[1][i]
        ax.plot(sd['pred_share'], sd['real_share'], marker='o', color=COLOR[lg])
        ax.plot([0.4, 1], [0.4, 1], color='grey', lw=1, ls='--')
        ax.set_xlabel('Predicted games share')
        ax.set_ylabel('Share of remaining team games played')
        ax.set_title(f"{LABEL[lg]}: games share calibration (corr {calibration[lg]['corr']:.2f})")
    plt.tight_layout()
    plt.show()
    if reliability:
        display(pd.concat({LABEL[lg]: r['slope'] for lg, r in reliability.items()}).round(3))
    display(pd.DataFrame({lg: {k: v for k, v in c.items() if k != 'deciles'} for lg, c in calibration.items()}).round(3))""",
    ),
    (
        "md",
        """## Minutes after a return from absence

A player back from several games out tends to play fewer minutes at first, and the projection's
last five games only show it once those games have been played. In season the board therefore
cuts the projected minutes of a player with five or more games this season who has missed three
or more straight games of their current team: by 1% per game missed (at most 50%) while still out,
half that after the first game back, and nothing from the second (`fantasy_return_ramp`, ADR 0003).
The team's games count from the player's first game for it this season, or from its first game
when it was their main team last season.

The test follows the in-season minutes protocol of ADR 0003. Every 14 days through each regular
season, every player with five or more games so far is projected as the board would have done,
with and without the cut, and compared with the mean minutes of their next 5 and next 10 games
played (at least 5). The rule was chosen on NBA 2023-24 and 2024-25 and WNBA 2018 to 2024
(`replay.RAMP_FIT_SEASONS`); later seasons are out of sample. *Bias* is actual minus projected
minutes; the interval is a 95% player-bootstrap interval on the change in error among the players
the cut applies to. The second table follows players up to five games back by the length of the
absence: the longer it was, the further the minutes fall short.""",
    ),
    (
        "code",
        """def minutes_checkpoints(r):
    \"\"\"Every 14 days of each regular season: projected minutes of every player with 5+ games so
    far, with the return ramp and without it, against the next 5 and 10 games played.\"\"\"
    g = r.games
    out = []
    for season in r.seasons():
        reg = g[(g['season'] == season) & g['regular']]
        if reg.empty:
            continue
        earlier = [s for s in r.seasons() if s < season]
        played = g[(g['season'] == season) & g['played']].sort_values(['game_date', 'game_id'])
        start, end = reg['game_date'].min(), reg['game_date'].max()
        for cut in pd.date_range(start + pd.Timedelta(days=14), end - pd.Timedelta(days=10), freq='14D'):
            before, after = played[played['game_date'] < cut], played[played['game_date'] >= cut]
            games = before.groupby('player_id').size()
            team = before[before['player_id'].isin(games[games >= 5].index)].groupby('player_id')['team_id'].last()
            if team.empty:
                continue
            proj = r.project(cut, team.rename('team_id').reset_index(), in_season=True, complete_seasons=earlier)
            df = proj[['proj_minutes_pg', 'return_minutes_factor', 'absence_games', 'games_since_return']].copy()
            df['as_built'] = df['proj_minutes_pg'] / df['return_minutes_factor']
            for n in (5, 10):
                t = after.groupby('player_id').head(n).groupby('player_id')['minutes'].agg(['mean', 'size'])
                df[f'next_{n}'] = t['mean'].where(t['size'] >= 5).reindex(df.index)
            df['season'], df['cut'] = season, cut
            out.append(df.reset_index())
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def player_interval(diff, players, reps=200, seed=7):
    \"\"\"Mean of diff with a basic player-bootstrap interval (Poisson weights per player).\"\"\"
    rng = np.random.default_rng(seed)
    ids, inv = np.unique(players, return_inverse=True)
    est = float(np.mean(diff)) if len(diff) else np.nan
    draws = []
    for _ in range(reps):
        w = rng.poisson(1.0, len(ids))[inv]
        if w.sum():
            draws.append(np.average(diff, weights=w))
    return (est, *basic_interval(est, np.array(draws)))


ramp_groups, ramp_lengths, ramp_summary = [], [], []
for lg, r in replays.items():
    d = minutes_checkpoints(r)
    if d.empty:
        continue
    d = d[d['next_5'].notna()].copy()
    d['sample'] = np.where(d['season'].isin(rp.RAMP_FIT_SEASONS[lg]), 'fitted on', 'out-of-sample')
    back = d['games_since_return']
    d['status'] = np.select([back.isna() | (back > 5), back == 0, back == 1],
                            ['no absence, or 6+ games back', 'still out', '1 game back'], '2 to 5 games back')
    for (sample, status), q in d.groupby(['sample', 'status']):
        row = {'league': LABEL[lg], 'sample': sample, 'status': status, 'players': len(q)}
        for n in (5, 10):
            row[f'bias next {n}, as built'] = (q[f'next_{n}'] - q['as_built']).mean()
            row[f'bias next {n}, ramp'] = (q[f'next_{n}'] - q['proj_minutes_pg']).mean()
        ramp_groups.append(row)
    recent = d[back <= 5].copy()
    recent['missed'] = pd.cut(recent['absence_games'], [2, 5, 10, 20, np.inf], labels=['3 to 5', '6 to 10', '11 to 20', '21 or more'])
    for (sample, missed), q in recent.groupby(['sample', 'missed'], observed=True):
        ramp_lengths.append({'league': LABEL[lg], 'sample': sample, 'games missed': missed, 'players': len(q),
                             'bias next 5, as built': (q['next_5'] - q['as_built']).mean(),
                             'bias next 5, ramp': (q['next_5'] - q['proj_minutes_pg']).mean(),
                             'bias next 10, as built': (q['next_10'] - q['as_built']).mean(),
                             'bias next 10, ramp': (q['next_10'] - q['proj_minutes_pg']).mean()})
    for sample, q in d.groupby('sample'):
        cut = (q['return_minutes_factor'] < 1).to_numpy()
        for n in (5, 10):
            before = (q[f'next_{n}'] - q['as_built']).abs().to_numpy()
            after = (q[f'next_{n}'] - q['proj_minutes_pg']).abs().to_numpy()
            est, lo, hi = player_interval(after[cut] - before[cut], q['player_id'].to_numpy()[cut])
            ramp_summary.append({'league': LABEL[lg], 'sample': sample, 'target': f'next {n} games',
                                 'checkpoints': q['cut'].nunique(), 'cut players': int(cut.sum()),
                                 'cut: as built': before[cut].mean(), 'cut: ramp': after[cut].mean(),
                                 'change': est, 'lo': lo, 'hi': hi, 'others (unchanged)': before[~cut].mean(),
                                 'everyone: as built': before.mean(), 'everyone: ramp': after.mean()})
if ramp_summary:
    display(pd.DataFrame(ramp_groups).round(2))
    display(pd.DataFrame(ramp_lengths).round(2))
    display(pd.DataFrame(ramp_summary).round(3))
else:
    print('No regular season long enough for 14-day minutes checkpoints in this build.')""",
    ),
    (
        "md",
        """## Aging before the season

Before a season the projection rests on last season and the two before it, and says nothing of
age. Players in their early twenties tend to gain minutes and per-minute production from one
season to the next, and players past thirty to lose them. The question is whether a curve of that
change by age makes the preseason board better.

The curve is the year-over-year change in minutes per game and in per-minute production (an equal
mix of points, rebounds, assists, steals, blocks and threes, each against the league's rate), by
age at the next season's first game, over players with 200 minutes (NBA) or 100 (WNBA) in both
seasons, weighted by the harmonic mean of the two seasons' minutes and fitted as a quadratic in age
(clipped to 20 to 36). Age comes from the roster birth date in `dim_player` ('MAR 03, 1996'). The
preseason projection's minutes and production are multiplied by the curve, scored again and
compared with the rest of the season like the board above. *Forward* fits the curve on the
transitions before the season it is tested on. *Cross-fitted* also uses later transitions, so it
is not a forward test: it is there because the NBA has a single forward season. Intervals are
95% player-bootstrap intervals on the change against the board as built.""",
    ),
    (
        "code",
        """RATE_MIX = ('points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made')
AGE_METHODS = {'minutes': 'Minutes curve', 'production': 'Production curve', 'both': 'Both curves'}


def birth_dates(lg):
    if 'birth_date' not in columns(con, 'dim_player'):
        return pd.Series(dtype='datetime64[ns]')
    b = con.sql(f"select stats_player_id as player_id, max(birth_date) as birth_date from dim_player "
                f"where league = '{lg}' group by 1").df()
    return pd.to_datetime(b.set_index('player_id')['birth_date'], format='%b %d, %Y', errors='coerce').dropna()


def season_pairs(r, birth, min_minutes):
    \"\"\"One row per player and pair of consecutive seasons: age, weight and log changes.\"\"\"
    parts = []
    for season, part in r.games.groupby('season'):
        ln = rp.lines(part)
        if len(ln):
            parts.append(ln.assign(season=season, start=part['game_date'].min()))
    if len(parts) < 2:
        return pd.DataFrame()
    ln = pd.concat(parts).rename_axis('player_id').reset_index()
    rate = {c: (ln[f'{c}_pg'] * ln['games']).sum() / ln['total_minutes'].sum() for c in RATE_MIX}
    ln['mix'] = sum(ln[f'{c}_pg'] / ln['minutes_pg'] / rate[c] for c in RATE_MIX) / len(RATE_MIX)
    seasons = sorted(ln['season'].unique())
    a = ln[ln['season'].isin(seasons[:-1])].assign(next=lambda x: x['season'].map(dict(zip(seasons[:-1], seasons[1:]))))
    p = a.merge(ln, left_on=['player_id', 'next'], right_on=['player_id', 'season'], suffixes=('', '_n'))
    p = p[(p['total_minutes'] >= min_minutes) & (p['total_minutes_n'] >= min_minutes)].copy()
    p['age'] = (p['start_n'] - p['player_id'].map(birth)).dt.days / 365.25
    p['w'] = 2 / (1 / p['total_minutes'] + 1 / p['total_minutes_n'])
    p['d_minutes'] = np.log(p['minutes_pg_n'] / p['minutes_pg'])
    p['d_production'] = np.log(p['mix_n'] / p['mix'])
    return p[p['age'].notna() & np.isfinite(p['d_production'])]


def age_curve(p, col):
    \"\"\"Weighted quadratic in age (clipped to 20 to 36) of a log change.\"\"\"
    x = p['age'].clip(20, 36).to_numpy() - 27
    sw = np.sqrt(p['w'].to_numpy())
    beta = np.linalg.lstsq(np.column_stack([np.ones_like(x), x, x**2]) * sw[:, None], p[col].to_numpy() * sw, rcond=None)[0]
    return lambda age: np.where(np.isfinite(age), np.polyval(beta[::-1], np.clip(age, 20, 36) - 27), 0.0)


def aged(proj, age, minutes=None, production=None):
    out = proj.copy()
    a = age.reindex(out.index).to_numpy(dtype=float)
    m = np.exp(minutes(a)) if minutes else 1.0
    q = np.exp(production(a)) if production else 1.0
    out['proj_minutes_pg'] = out['proj_minutes_pg'] * m
    for c in rp.PRODUCTION:
        out[f'proj_{c}_pg'] = out[f'proj_{c}_pg'] * m * q
    return out


age_pairs, age_records, age_frames = {}, [], {}
for lg, r in replays.items():
    birth = birth_dates(lg)
    p = season_pairs(r, birth, 200 if lg == 'nba' else 100)
    if p.empty:
        continue
    age_pairs[lg] = p
    for season in complete_seasons(r):
        cps = r.checkpoints(season)
        if not cps or cps[0][0] != 'preseason':
            continue
        day = cps[0][1]
        roster = r.roster_at(season, day, preseason=True)
        proj = r.project(day, roster, in_season=False, complete_seasons=[s for s in r.seasons() if s < season])
        real = r.realised(season, day, roster)
        ids = real.index
        age = (day - proj.index.to_series().map(birth)).dt.days / 365.25
        for fit, train in (('forward', p[p['season_n'] < season]), ('cross-fitted', p[p['season_n'] != season])):
            if train['season_n'].nunique() < 1 or len(train) < 50:
                continue
            fm, fp = age_curve(train, 'd_minutes'), age_curve(train, 'd_production')
            variants = {'built': proj, 'minutes': aged(proj, age, minutes=fm), 'production': aged(proj, age, production=fp),
                        'both': aged(proj, age, minutes=fm, production=fp)}
            pred = {}
            for name, pj in variants.items():
                v = rp.score(pj, r.settings)
                total = v['value_per_game'].where(v['value_per_game'] <= 0, v['value_per_game'] * pj['games_share'])
                pred[name] = (v['value_per_game'].reindex(ids).fillna(0).to_numpy(), total.reindex(ids).fillna(0).to_numpy())
                age_records.append({'league': lg, 'fit': fit, 'season': season, 'transitions': train['season_n'].nunique(),
                                    'method': name, **rp.evaluate(*pred[name], real['value_pg'].to_numpy(), real['eligible'].to_numpy(),
                                                                  real['value_total'].to_numpy(), rp.TOP_N[lg])})
            age_frames.setdefault((lg, fit), []).append({'season': season, 'player_id': ids.to_numpy(), 'pred': pred,
                                                         'value_pg': real['value_pg'].to_numpy(), 'eligible': real['eligible'].to_numpy(),
                                                         'value_total': real['value_total'].to_numpy()})
if age_pairs:
    curve = []
    for lg, p in age_pairs.items():
        bands = pd.cut(p['age'], [0, 23, 26, 29, 32, 50], labels=['under 23', '23 to 26', '26 to 29', '29 to 32', '32 and over'])
        for band, q in p.groupby(bands, observed=True):
            curve.append({'league': LABEL[lg], 'age': band, 'pairs': len(q),
                          'minutes per game, change': np.expm1(np.average(q['d_minutes'], weights=q['w'])),
                          'production per minute, change': np.expm1(np.average(q['d_production'], weights=q['w']))})
    display(pd.DataFrame(curve).round(3))
else:
    print('No pair of consecutive seasons with birth dates in this build.')""",
    ),
    (
        "code",
        """AGE_METRICS = ['top_total', 'top_pg', 'spearman_total', 'spearman_pg', 'mae_pg', 'capture']
age_rows = []
age_results = pd.DataFrame(age_records)
for (lg, fit), fr in age_frames.items():
    point = age_results[(age_results['league'] == lg) & (age_results['fit'] == fit)]
    seasons = sorted(point['season'].unique())
    groups = [('latest', seasons[-(2 if lg == 'wnba' else 1):]), ('every season', seasons)]
    b = rp.bootstrap(fr, rp.TOP_N[lg], reps=200)
    b['season'] = b['frame'].map({k: f['season'] for k, f in enumerate(fr)})
    for label, keep in groups:
        if label == 'every season' and len(keep) == len(groups[0][1]):
            continue
        pm, bm = point[point['season'].isin(keep)], b[b['season'].isin(keep)]
        means = pm.groupby('method')[AGE_METRICS].mean()
        kept = [f for f in fr if f['season'] in keep]
        real_total = np.concatenate([f['value_total'] for f in kept])

        def slope_above(method):
            pred_total = np.concatenate([f['pred'][method][1] for f in kept])
            return fit_slope(pred_total[pred_total > 0], real_total[pred_total > 0])

        for method in AGE_METHODS:
            row = {'league': LABEL[lg], 'fit': fit, 'seasons': f"{keep[0]} to {keep[-1]}" if len(keep) > 1 else keep[0],
                   'method': AGE_METHODS[method],
                   'slope above replacement': f"{slope_above('built'):.2f} to {slope_above(method):.2f}"}
            for m in AGE_METRICS:
                wide = bm.pivot_table(index=['rep', 'frame'], columns='method', values=m)
                d = (wide[method] - wide['built']).groupby('rep').mean()
                gap = means.loc[method, m] - means.loc['built', m]
                lo, hi = basic_interval(gap, d)
                row[m] = f"{means.loc['built', m]:.3f} to {means.loc[method, m]:.3f}, {gap:+.3f} ({lo:+.3f} to {hi:+.3f})"
            age_rows.append(row)
if age_rows:
    display(pd.DataFrame(age_rows))
else:
    print('No preseason checkpoint with a fitted curve in this build.')""",
    ),
    (
        "md",
        """On the history behind ADR 0003's aging addendum the curve is real but adds little to what the
projection already knows. Over seven forward WNBA seasons it raised no hit rate or rank
correlation, and the only intervals clear of zero were small losses. The NBA's single forward
season (2025-26, a curve from one transition) gained four of the top 50, but cross-fitted 2024-25
lost one, and a player bootstrap of one season resamples players, not seasons. Rank correlation
rose by about 0.01 and the error per game fell in both NBA seasons; a change of scale also lowers
that error (ADR 0003, the value spread addendum). So the board does not age players, and this
section re-tests the curve as NBA seasons accumulate.""",
    ),
    (
        "md",
        """## Parity: the replay against this build's projection

Replayed as of the day after the build's latest game, with the build's own rostered players,
the replay should reproduce `mart_player_projection` to rounding. A disagreement means the replay
has drifted from the dbt model and the backtest above no longer describes the board.""",
    ),
    (
        "code",
        """parity = {}
if has_table(con, 'mart_player_projection'):
    for lg, r in replays.items():
        proj = con.sql(f"select * from mart_player_projection where league = '{lg}'").df()
        if proj.empty:
            continue
        done = complete_seasons(r)
        current = r.seasons()[-1]
        if 'season_complete' in columns(con, 'mart_board'):
            # the build's own word on whether its regular season is over (no regular-season games left)
            flags = con.sql(f"select bool_and(season_complete) from mart_board where league = '{lg}'").fetchall()[0][0]
            if flags is not None:
                done = [s for s in done if s != current] + ([current] if flags else [])
        as_of = r.games['game_date'].max() + pd.Timedelta(days=1)
        rep = r.project(as_of, proj[['player_id', 'team_id']], in_season=current not in done,
                        complete_seasons=done)
        build = proj.set_index('player_id')
        compared = [c for c in build.columns if c.startswith('proj_') and c in rep.columns] + ['games_share']
        rep = rep.reindex(build.index)
        diff = (build[compared].astype(float) - rep[compared].astype(float)).abs()
        tol = 1e-6 * (1 + build[compared].astype(float).abs())
        agree = (diff <= tol).all(axis=1)
        parity[lg] = {'players': len(build), 'agree': int(agree.sum()), 'max_abs_diff': float(diff.max().max())}
        if has_table(con, 'mart_board'):
            vb = con.sql(f"select player_id, value_per_game from mart_board where league = '{lg}'").df().set_index('player_id')
            rv = rp.score(rep.dropna(subset=['proj_minutes_pg']), SETTINGS[lg])['value_per_game']
            vb = vb.join(rv.rename('replay'), how='inner')
            parity[lg]['value_max_abs_diff'] = float((vb['value_per_game'] - vb['replay']).abs().max()) if len(vb) else None
if parity:
    display(pd.DataFrame(parity).T)
else:
    print('This build has no projection rows to compare with.')""",
    ),
    (
        "code",
        """def fmt_ci(x, lo, hi, digits=2):
    return f"{x:.{digits}f} ({lo:.{digits}f} to {hi:.{digits}f})"


def row(lg, sample, method):
    s = summary[(summary['league'] == lg) & (summary['sample'] == sample) & (summary['method'] == method)] if len(summary) else summary
    return s.iloc[0] if len(s) else None


for lg in LEAGUES:
    res = results[results['league'] == lg] if len(results) else results
    n = int((players['league'] == lg).sum()) if len(players) else 0
    if lg not in replays or res.empty or lg not in boot:
        findings[lg] = insufficient(
            f"Not enough history in this build: the backtest needs a finished {LABEL[lg]} regular season "
            "to replay, and this build has none yet.", n=n, n_label='player-checkpoints')
        continue
    N = rp.TOP_N[lg]
    b_all, last_all, td_all = (row(lg, 'all', m) for m in METHODS)
    oos = row(lg, 'out-of-sample', 'board')
    headline = (f"Across {int(b_all['checkpoints'])} checkpoints, {b_all['top_total']:.0%} of the board's top {N} "
                f"finished in the realised top {N}"
                + (f", against {last_all['top_total']:.0%} for last season's per-game value" if last_all is not None else '')
                + (f" and {td_all['top_total']:.0%} for the season to date" if td_all is not None else '')
                + (f"; out of sample, {oos['top_total']:.0%}." if oos is not None else '; every season replayed was used to tune it.'))
    facts = []
    for sample in ['out-of-sample', 'in-sample']:
        x = row(lg, sample, 'board')
        if x is not None:
            seasons = sorted(res[res['sample'] == sample]['season'].unique())
            span = seasons[0] if len(seasons) == 1 else f"{seasons[0]} to {seasons[-1]}"
            facts.append({'label': f'Top-{N} hit rate, {sample} ({span})',
                          'value': fmt_ci(x['top_total'], x['top_total_lo'], x['top_total_hi'])})
    g = gaps[(gaps['league'] == lg) & (gaps['sample'] == 'all') & (gaps['metric'] == 'top_total')] if len(gaps) else gaps
    for _, x in g.iterrows():
        facts.append({'label': f"Board minus {METHODS[x['against']].lower()}, top-{N} hits (same checkpoints)",
                      'value': f"{x['gap']:+.3f} ({x['lo']:+.3f} to {x['hi']:+.3f})"})
    rel, cal = reliability.get(lg), calibration.get(lg)
    if rel:
        rs = rel['slope'].loc['all']
        facts.append({'label': 'Reliability slope above replacement (per game)',
                      'value': f"{rs['above replacement']:.2f} ({rs['per game']:.2f})"})
    if cal:
        facts.append({'label': 'Games share, predicted vs played',
                      'value': f"{cal['pred']:.2f} vs {cal['real']:.2f} (correlation {cal['corr']:.2f})"})
    if lg in parity:
        facts.append({'label': "Replay vs this build's projection",
                      'value': f"{parity[lg]['agree']} of {parity[lg]['players']} players agree"})
    if len(facts) > 6 and oos is not None:
        facts.pop(1)  # the in-sample hit rate; the notebook shows it in full
    table_rows = []
    for label in [*CHECKPOINT_ORDER, 'all']:
        part = res if label == 'all' else res[res['checkpoint'] == label]
        means = part.groupby('method')['top_total'].mean()
        table_rows.append([label] + [None if m not in means else round(float(means[m]), 3) for m in METHODS])
    findings[lg] = {
        'headline': headline,
        'facts': facts[:6],
        'table': {'columns': [f'Checkpoint (top-{N} hit rate)', *METHODS.values()], 'rows': table_rows},
        'n': n,
        'n_label': 'player-checkpoints',
    }
save_findings('01_board_backtest', {'title': 'Board backtest', 'leagues': findings})
findings""",
    ),
]
