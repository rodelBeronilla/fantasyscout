"""02_streamer_signals: which streamer signal finds next week's best pickups?"""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Streamer signals: which one finds next week's best pickups?

**The question.** The Streamers page lists the players a league has most likely left on the wire,
with a minutes trend (the default sort), a value trend, recent value, games in the next seven
days and the board's value. A manager adding a player on Monday wants the one who produces most
over the coming week. Which of those columns, sorted on, puts that player at the top?

**Why it matters.** A streaming slot is filled every week of the season. If the default sort
points at the wrong signal, a manager following it loses value every week, quietly.""",
    ),
    (
        "md",
        """## Method

- **Every Monday of every regular season**, using only the games before that day, the candidates
  are built as `mart_streamers` builds them: three or more games this season and a game in the
  last 30 days, and outside the rostered pool, which is the top `teams x roster spots` players on
  the board replayed as of that Monday (`replay.py`).
- **Signals**, as `mart_streamers` computes them: the minutes trend (last five games against a
  baseline of the games before, blended with last season counted as up to ten games), the value
  trend (last-ten value against a baseline of the season and last season), the last-ten value,
  minutes over the last five, games in the next seven days (the schedule is published in
  advance), starts in the last five, the page's window value (last-ten value times games) and
  the board's value.
- **Target**: what the player added to a week's nine category totals over the next seven days.
  Each game's counting stats are taken in units of the category's spread over the season's pool
  (turnovers subtract), and its shooting as makes above the pool's percentage on its attempts,
  in units of that impact's spread: the board's weights, applied to totals rather than averages,
  because a weekly matchup adds up what a roster produces. A game the player did not play adds
  nothing, so games in the week and availability are part of the target.
- **One more sort to try**: the week projected from the last ten games, the same per-game
  contribution on the season-to-date scale times the team's games in the week.
- **Measures**: the weekly rank correlation of each signal with the target (mean over weeks, and
  a t-statistic of the weekly values), the target by decile of each signal, and the top-10 hit
  rate of each sort (the share of the week's ten best candidates the sort puts in its top ten). A
  fitted blend of the signals is fitted on the earlier seasons; every measure is reported on the
  latest season, which no fit has seen, and on the earlier ones for comparison.""",
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

SIGNALS = {
    'minutes_trend': 'Minutes trend (the default sort)',
    'value_trend': 'Value trend',
    'last_10_z_total': 'Value, last ten games',
    'minutes_avg_5': 'Minutes, last five games',
    'games_next_7': 'Games in the next seven days',
    'starts_last_5': 'Starts in the last five games',
    'window_value': 'Window value (last-ten value x games)',
    'board_value': 'Board value',
    'week_projection': 'Last-ten production x games',
}
PRIOR = 10  # mart_streamers: last season counts as up to ten games in the baselines


def value_scale(rows, lg):
    \"\"\"Each category's spread over the pool's per-game lines, and the pool's shooting percentages.\"\"\"
    ln = rp.lines(rows)
    pool = ln.sort_values('total_minutes', ascending=False).index[: rp.ZSCORE_POOL[lg]]
    p = ln.loc[pool]
    scale = {c: p[f'{c}_pg'].std() for c in rp.COUNTING}
    for name, made, att, att_pg in (('fg', 'fgm', 'fga', 'fga_pg'), ('ft', 'ftm', 'fta', 'fta_pg')):
        pct = p[made].sum() / p[att].sum()
        scale[name] = (pct, ((p[made] / p[att].replace(0, np.nan) - pct) * p[att_pg]).std())
    return scale


def contribution(rows, scale):
    \"\"\"What each game adds to a week's category totals, in units of each category's spread.

    Counting stats add to the totals (turnovers subtract); shooting adds its makes above the
    pool's percentage on its attempts. A game not played adds nothing.
    \"\"\"
    v = pd.Series(0.0, index=rows.index)
    for c in rp.COUNTING:
        x = rows[c].fillna(0) / scale[c]
        v += -x if c == 'turnovers' else x
    for name, made, att in (('fg', 'fgm', 'fga'), ('ft', 'ftm', 'fta')):
        pct, sd = scale[name]
        v += (rows[made].fillna(0) - pct * rows[att].fillna(0)) / sd
    return v


def season_values(r, lg, season):
    \"\"\"Every played regular-season game of a season, valued on the season's scale.\"\"\"
    g = r.games
    rows = g[(g['season'] == season) & g['regular'] & g['played']].copy()
    rows['value'] = contribution(rows, value_scale(rows, lg))
    return rows


def previous_lines(r, lg, season):
    \"\"\"Each player's latest earlier season with games: games, minutes and season value.\"\"\"
    g = r.games
    out = []
    for s in [x for x in r.seasons() if x < season]:
        z = rp.category_z(rp.lines(g[g['season'] == s]), rp.ZSCORE_POOL[lg])
        out.append(z[['games', 'minutes_pg', 'z_total']].assign(season=s))
    if not out:
        return pd.DataFrame(columns=['games', 'minutes_pg', 'z_total'])
    prev = pd.concat(out).rename_axis('player_id').reset_index().sort_values('season')
    return prev.drop_duplicates('player_id', keep='last').set_index('player_id')""",
    ),
    (
        "code",
        """def mondays(r, season):
    g = r.games
    dates = g.loc[(g['season'] == season) & g['regular'], 'game_date']
    if dates.empty:
        return []
    first, last = dates.min(), dates.max()
    return [m for m in pd.date_range(first + pd.Timedelta(days=7), last, freq='W-MON')
            if m + pd.Timedelta(days=6) <= last]


def week(r, lg, season, monday, values, prev, schedule, earlier):
    g = r.games
    s = SETTINGS[lg]
    rows = g[(g['season'] == season) & (g['game_date'] < monday)]
    played = rows[rows['played']].sort_values(['game_date', 'game_id'])
    if played.empty:
        return None
    season_z = rp.category_z(rp.lines(played), rp.ZSCORE_POOL[lg])
    last10 = rp.category_z(rp.lines(played.groupby('player_id').tail(10)), rp.ZSCORE_POOL[lg])
    last5 = played.groupby('player_id').tail(5).groupby('player_id').agg(
        minutes_avg_5=('minutes', 'mean'), games_in_window_5=('minutes', 'size'), starts_last_5=('started', 'sum'))
    latest = played.groupby('player_id').agg(last_game=('game_date', 'max'), team_id=('team_id', 'last'))
    f = season_z[['games', 'minutes_pg', 'z_total']].rename(columns={'z_total': 'season_z_total'})
    f = f.join(last10['z_total'].rename('last_10_z_total')).join(last5).join(latest)
    f = f.join(prev.rename(columns={'games': 'prev_games', 'minutes_pg': 'prev_minutes', 'z_total': 'prev_z'}))
    league_last = played['game_date'].max()
    f = f[(f['games'] >= 3) & (f['last_game'] >= league_last - pd.Timedelta(days=30))].copy()
    # baselines, as mart_streamers: the games before the window, blended with last season
    before5 = (f['games'] - f['games_in_window_5']).clip(lower=0)
    minutes_before5 = (f['minutes_pg'] * f['games'] - f['minutes_avg_5'] * f['games_in_window_5']) / before5.replace(0, np.nan)
    before10 = (f['games'] - f['games'].clip(upper=10)).clip(lower=0)
    weight = f['prev_games'].fillna(0).clip(upper=PRIOR)
    f['minutes_baseline'] = ((before5 * minutes_before5).fillna(0) + (weight * f['prev_minutes']).fillna(0)) / (
        before5 + weight.where(f['prev_minutes'].notna(), 0)).replace(0, np.nan)
    f['value_baseline'] = ((before10 * f['season_z_total']).fillna(0) + (weight * f['prev_z']).fillna(0)) / (
        before10 + weight.where(f['prev_z'].notna(), 0)).replace(0, np.nan)
    f['minutes_trend'] = f['minutes_avg_5'] - f['minutes_baseline']
    f['value_trend'] = f['last_10_z_total'] - f['value_baseline']
    # the team's games in the next seven days
    end = monday + pd.Timedelta(days=7)
    upcoming = schedule[(schedule['game_date'] >= monday) & (schedule['game_date'] < end)].groupby('team_id').size()
    f['games_next_7'] = f['team_id'].map(upcoming).fillna(0)
    f['window_value'] = f['last_10_z_total'] * f['games_next_7']
    recent = played.groupby('player_id').tail(10)
    per_game = contribution(recent, value_scale(played, lg)).groupby(recent['player_id']).mean()
    f['week_projection'] = per_game.reindex(f.index) * f['games_next_7']
    # outside the rostered pool on the board as of that Monday
    board = r.board(monday, r.roster_at(season, monday, preseason=False), in_season=True, complete_seasons=earlier)
    f['board_rank'] = board['rank_total'].reindex(f.index) if len(board) else np.nan
    f['board_value'] = board['value_total'].reindex(f.index) if len(board) else np.nan
    f = f[~(f['board_rank'] <= s.pool_size)]
    nxt = values[(values['game_date'] >= monday) & (values['game_date'] < end)]
    f['target'] = nxt.groupby('player_id')['value'].sum().reindex(f.index).fillna(0)
    f['games_played_next_7'] = nxt.groupby('player_id').size().reindex(f.index).fillna(0)
    for c in [*SIGNALS, 'target']:
        f[c] = pd.to_numeric(f[c], errors='coerce').astype(float)
    return f.assign(league=lg, season=season, monday=monday.date())


weeks = []
for lg, r in replays.items():
    g = r.games
    for season in r.seasons():
        ms = mondays(r, season)
        if not ms:
            continue
        values = season_values(r, lg, season)
        prev = previous_lines(r, lg, season)
        schedule = g[(g['season'] == season) & g['regular']][['team_id', 'game_id', 'game_date']].drop_duplicates()
        earlier = [x for x in r.seasons() if x < season]
        for m in ms:
            w = week(r, lg, season, m, values, prev, schedule, earlier)
            if w is not None and len(w) >= 20:
                weeks.append(w.rename_axis('player_id').reset_index())
streams = pd.concat(weeks, ignore_index=True) if weeks else pd.DataFrame()
if len(streams):
    display(streams.groupby(['league', 'season']).agg(mondays=('monday', 'nunique'), candidates=('player_id', 'size'),
                                                        mean_target=('target', 'mean')).round(3))
else:
    print('No regular-season Monday with a full week after it in this build.')""",
    ),
    (
        "code",
        """def split(lg):
    \"\"\"The latest season with four or more Mondays is the test; the earlier ones fit.\"\"\"
    part = streams[streams['league'] == lg]
    counts = part.groupby('season')['monday'].nunique()
    seasons = sorted(counts[counts >= 4].index)
    if not seasons:
        return None, part.iloc[0:0], part.iloc[0:0]
    test = seasons[-1]
    return test, part[part['season'] < test], part[part['season'] == test]


def weekly(part, key):
    vals = [rp.spearman(w[key].to_numpy(), w['target'].to_numpy()) for _, w in part.groupby('monday')]
    vals = np.array([v for v in vals if np.isfinite(v)])
    if len(vals) < 2:
        return np.nan, np.nan, len(vals)
    return vals.mean(), vals.mean() / (vals.std(ddof=1) / np.sqrt(len(vals))), len(vals)


def top10(part, key):
    hits = [rp.top_hits(w[key].fillna(-np.inf).to_numpy(), w['target'].to_numpy(), 10) for _, w in part.groupby('monday')]
    return float(np.mean(hits)) if hits else np.nan


def top10_value(part, key):
    vals = [w.nlargest(10, key)['target'].mean() for _, w in part.groupby('monday')]
    return float(np.mean(vals)) if vals else np.nan


def standardise(part, keys):
    z = part[keys].astype(float)
    grouped = z.groupby(part['monday'])
    z = (z - grouped.transform('mean')) / grouped.transform('std').replace(0, np.nan)
    return z.fillna(0)


tables, tests, blends = {}, {}, {}
for lg in LEAGUES:
    if not len(streams):
        continue
    test, train, held = split(lg)
    if test is None:
        continue
    tests[lg] = test
    keys = list(SIGNALS)
    if len(train) > 100:
        X = np.c_[np.ones(len(train)), standardise(train, keys).to_numpy()]
        beta = np.linalg.lstsq(X, train['target'].to_numpy(), rcond=None)[0]
        blends[lg] = dict(zip(['intercept', *keys], beta, strict=True))
        held = held.assign(blend=np.c_[np.ones(len(held)), standardise(held, keys).to_numpy()] @ beta)
        train = train.assign(blend=X @ beta)
    rows = []
    for key in keys + (['blend'] if 'blend' in held else []):
        mean_t, t_t, k = weekly(held, key)
        mean_e, t_e, _ = weekly(train, key) if len(train) else (np.nan, np.nan, 0)
        rows.append({'signal': SIGNALS.get(key, 'Fitted blend of all signals'), 'key': key,
                     'test_rank_corr': mean_t, 'test_t': t_t, 'earlier_rank_corr': mean_e, 'earlier_t': t_e,
                     'test_top10': top10(held, key), 'earlier_top10': top10(train, key) if len(train) else np.nan,
                     'test_top10_value': top10_value(held, key), 'weeks': k})
    tables[lg] = (pd.DataFrame(rows).set_index('key'), held)
    print(f"{LABEL[lg]}: test season {test}, fitted on {', '.join(sorted(train['season'].unique())) or 'nothing'}")
    display(tables[lg][0].round(3))
    if lg in blends:
        print('Blend weights (target per standard deviation of each signal):', {k: round(v, 3) for k, v in blends[lg].items()})""",
    ),
    (
        "md",
        """## The target by decile of each signal

Candidates are cut into deciles of each signal every Monday of the test season. The line is the
average next-seven-day value in each decile, less the week's average candidate: a useful signal
rises from left to right.""",
    ),
    (
        "code",
        """if tables:
    shown = ['minutes_trend', 'value_trend', 'last_10_z_total', 'games_next_7', 'starts_last_5']
    fig, axes = plt.subplots(1, len(tables), figsize=(6 * len(tables), 4), squeeze=False)
    for ax, (lg, (table, held)) in zip(axes[0], tables.items(), strict=False):
        for key in shown:
            d = held.assign(decile=held.groupby('monday')[key].transform(
                lambda x: pd.qcut(x.rank(method='first'), 10, labels=False) + 1 if x.notna().sum() >= 10 else np.nan))
            d['lift'] = d['target'] - d.groupby('monday')['target'].transform('mean')
            line = d.groupby('decile')['lift'].mean()
            ax.plot(line.index, line.to_numpy(), marker='o', label=SIGNALS[key])
        ax.axhline(0, color='grey', lw=1)
        ax.set_xlabel('Decile of the signal (10 = highest)')
        ax.set_ylabel('Next-7-day value against the average candidate')
        ax.set_title(f'{LABEL[lg]} {tests[lg]}')
        ax.legend(fontsize=8)
    plt.tight_layout()
    plt.show()""",
    ),
    (
        "code",
        """for lg in LEAGUES:
    if lg not in tables:
        n = int((streams['league'] == lg).sum()) if len(streams) else 0
        findings[lg] = insufficient(
            f"Not enough history in this build: the {LABEL[lg]} replay needs four or more regular-season Mondays "
            "with a full week after them, and this build has fewer.", n=n, n_label='candidate-weeks')
        continue
    table, held = tables[lg]
    page_sorts = [k for k in ['minutes_trend', 'value_trend', 'last_10_z_total', 'minutes_avg_5', 'games_next_7',
                              'window_value', 'board_value'] if k in table.index]
    best_any = table.drop(index=[k for k in ['blend'] if k in table.index])['test_top10'].idxmax()
    best = table.loc[page_sorts, 'test_top10'].idxmax()
    default = table.loc['minutes_trend']
    strongest = table.drop(index=[k for k in ['blend'] if k in table.index])['test_rank_corr'].idxmax()
    test = tests[lg]

    def name(key):
        return SIGNALS[key].split(' (')[0].lower()

    headline = (f"On {test} Mondays, the default sort (minutes trend) put {default['test_top10'] * 10:.1f} of the week's "
                f"ten best pickups in its top ten. Sorting by {name(best_any)} put {table.loc[best_any, 'test_top10'] * 10:.1f}"
                + (f"; of the columns the page sorts on now, {name(best)} did best ({table.loc[best, 'test_top10'] * 10:.1f})."
                   if best != best_any else '.'))
    facts = [
        {'label': f'Weeks and candidates, {test}', 'value': f"{held['monday'].nunique()} Mondays, {len(held):,} candidate-weeks"},
        {'label': 'Minutes trend, weekly rank correlation', 'value': f"{default['test_rank_corr']:.3f} (t = {default['test_t']:.1f}); earlier seasons {default['earlier_rank_corr']:.3f}"},
        {'label': 'Strongest single signal by rank correlation', 'value': f"{SIGNALS[strongest].split(' (')[0]}: {table.loc[strongest, 'test_rank_corr']:.3f} (t = {table.loc[strongest, 'test_t']:.1f})"},
        {'label': 'Games in the next seven days, rank correlation', 'value': f"{table.loc['games_next_7', 'test_rank_corr']:.3f}"},
        {'label': f'Week value of the top ten: {name(best_any)} vs default', 'value': f"{table.loc[best_any, 'test_top10_value']:.1f} vs {default['test_top10_value']:.1f}"},
    ]
    if 'blend' in table.index:
        facts.append({'label': 'Fitted blend of every signal, top-10 hits', 'value': f"{table.loc['blend', 'test_top10'] * 10:.1f} of 10 (fitted on earlier seasons)"})
    findings[lg] = {
        'headline': headline,
        'facts': facts,
        'table': {'columns': ['Sort', f'Top-10 hits, {test}', 'Top-10 hits, earlier', f'Weekly rank corr, {test}'],
                  'rows': [[r['signal'], round(r['test_top10'] * 10, 2),
                            None if pd.isna(r['earlier_top10']) else round(r['earlier_top10'] * 10, 2),
                            round(r['test_rank_corr'], 3)] for _, r in table.sort_values('test_top10', ascending=False).iterrows()]},
        'n': int(len(held)),
        'n_label': f'candidate-weeks in {test}',
    }
save_findings('02_streamer_signals', {'title': 'Streamer signals', 'leagues': findings})
findings""",
    ),
]
