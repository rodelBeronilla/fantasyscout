"""01_board_backtest: does the board's projection rank the players who go on to produce?"""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Board backtest: does the projection find the players who go on to produce?

**The question.** Every draft pick and most in-season adds lean on the board's ranking. The
board does more than average past seasons: it blends production per minute and minutes per game
with recency weights, discounts a role on another team, follows the last five games in season,
starts every player from a few games of a replacement-level line and scales by how often the
player plays (ADR 0003). That machinery is only worth having if it ranks the players who go on
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
  is fully untouched by it.""",
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
