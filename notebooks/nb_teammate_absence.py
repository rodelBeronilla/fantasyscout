"""07_teammate_absence: when a big teammate is out, who gains, and does it beat the last ten games?"""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Teammate absence: who picks up the minutes and the shots?

**The question.** When a teammate who plays big minutes or uses many of the team's possessions is
known to be out for the coming games, how much do the remaining players' minutes, usage and
fantasy production per game rise? And does a point-in-time adjustment for that absence predict
the affected players' next week better than their last ten games do?

**Why it matters.** A star going down is the most common reason a manager adds a player. The board
and Streamers read the last ten games, which already hold any absence that started a while ago.
An adjustment earns a place only if it adds something the last ten games do not. The minutes
replay in ADR 0003 found that the minutes of teammates who sat out the latest game added nothing
beyond the last five games. This study differs in two ways. It uses absences known in advance,
and it targets production and usage over the following week, not only minutes.""",
    ),
    (
        "md",
        """## Method

- **Rosters.** A player is on a team from the first game listed with it to the last, or to the
  end of the team's season for the player's last team (as in the game context notebook). A
  teammate who did not play a team game in that span was absent from it.
- **A teammate's share,** as of the game: minutes per game so far this season over the team's
  minutes (five on the floor), and usage share, the share of the team's possessions the teammate
  uses in an average game (usage rate times minutes per game over the game's length). Before a
  teammate's fifth game, last season's figures stand in.
- **Known in advance.** Where the league's official injury report lists the game
  (`fct_official_listing`: NBA 2023-24 on, WNBA 2026), a teammate listed Out who then did not
  play. Elsewhere, an approximation: a teammate who missed the team's previous game and this one.
  A multi-game absence is usually announced, so the approximation stands in for a listing, but
  it is not one.
- **The absence measure** is the known-out share of the team's minutes or usage in this game,
  less its average over the player's earlier games this season (realised absences). An absence
  the player's own average already holds counts for nothing. It is split into teammates at the
  player's position (G, F or C) and the others.
- **(a) Game by game.** Every regular-season game a player played, with five or more games and
  10 or more minutes a game so far. Outcomes are measured against the player's season to date:
  minutes; usage (percentage points); fantasy points per 36 minutes (ESPN's default points:
  PTS + REB + 2 AST + 4 STL + 4 BLK + 3PM - 2 TO + 2 FGM - FGA + FTM - FTA); fantasy points per
  game; and production per game in the Streamers unit. Production is what a game adds to the
  week's category totals, in units of each category's spread over the season's pool, as
  `mart_streamers.last_10_production` measures it. Usage and per-36 outcomes need 10 or more
  minutes. A linear model per outcome, by role (starter: half or more of the games so far
  started; else bench) and by position, is fitted on the earlier seasons and estimated again on
  the latest finished season, with 95% intervals from resampling players.
- **(b) Monday replays.** Every regular-season Monday, for each team, the top teammate is the one
  with the largest usage share so far (five or more games). The study takes the players whose
  top teammate is known out through the week: listed Out for the team's first game of the week
  where the report covers it, else out for the team's last game before Monday, and out for every
  team game of the week. The affected players are the team's other players with five or more
  games who played in the week. Predictors of their production per game played that week:
  - **Last ten:** the average of their last ten games.
  - **Last ten plus the average uplift:** the same amount for every affected player, the
    earlier seasons' average change from the last ten.
  - **Last ten plus redistribution:** the game-by-game slopes from (a), fitted on the earlier
    seasons, times the known-out share of the week less its average over those last ten games.
  - **Last ten plus their own split:** the gap between the player's games this season without
    that teammate and with them, shrunk by five games. It is scaled by how many of the last ten
    games the teammate played.

  Each predictor is scored by mean absolute error on the latest season, with a 95% player-bootstrap
  interval for its difference from the last ten, and on the earlier seasons for comparison. Only
  games before each Monday enter a predictor. The one exception is the selection itself: the
  week's absence is known in advance on a listing, and the approximation reads it from the games.""",
    ),
    setup(),
    (
        "code",
        """import replay as rp

FP = {'points': 1, 'rebounds_total': 1, 'assists': 2, 'steals': 4, 'blocks': 4, 'three_pointers_made': 1,
      'turnovers': -2, 'fgm': 2, 'fga': -1, 'ftm': 1, 'fta': -1}
GAME_MINUTES = {'nba': 48, 'wnba': 40}
TYPICAL_USAGE = 0.2  # one of five on the floor; stands in where a game has no usage rate
pcols = columns(con, 'fct_player_game')
extra = [c for c in ('usage_percentage',) if c in pcols]
cols = ', '.join((*rp.GAME_COLUMNS, *extra))


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
    \"\"\"What each game adds to a week's category totals, in units of each category's spread.\"\"\"
    v = pd.Series(0.0, index=rows.index)
    for c in rp.COUNTING:
        x = rows[c].fillna(0) / scale[c]
        v += -x if c == 'turnovers' else x
    for name, made, att in (('fg', 'fgm', 'fga'), ('ft', 'ftm', 'fta')):
        pct, sd = scale[name]
        v += (rows[made].fillna(0) - pct * rows[att].fillna(0)) / sd
    return v


def finished(g):
    seasons = sorted(g['season'].unique())
    playoffs = set(g.loc[~g['regular'], 'season'])
    return [s for i, s in enumerate(seasons) if s in playoffs or i < len(seasons) - 1]


games, done = {}, {}
for lg in LEAGUES:
    g = con.sql(f"select {cols} from fct_player_game where league = '{lg}'").df()
    if g.empty:
        continue
    g = rp.prepare(g)
    done[lg] = finished(g)
    g = g[g['regular']].copy()
    g['fp'] = sum(w * g[c].fillna(0) for c, w in FP.items())
    g['usage'] = pd.to_numeric(g['usage_percentage'], errors='coerce') if 'usage_percentage' in g else np.nan
    g['prod'] = np.nan
    for season, part in g.groupby('season'):
        played = part[part['played']]
        if len(played) >= 50:
            g.loc[played.index, 'prod'] = contribution(played, value_scale(played, lg))
    games[lg] = g

positions = {}
if {'league', 'stats_player_id', 'position', 'valid_from'} <= columns(con, 'dim_player'):
    d = con.sql("select league, stats_player_id as player_id, position from dim_player where position is not null "
                "qualify row_number() over (partition by league, stats_player_id order by valid_from desc) = 1").df()
    for lg, part in d.groupby('league'):
        positions[lg] = part.set_index('player_id')['position'].astype(str).str[0]

need = {'league', 'game_id', 'team_id', 'player_id', 'status'}
listings = (con.sql("select league, game_id, team_id, player_id, status from fct_official_listing").df()
            if need <= columns(con, 'fct_official_listing') else pd.DataFrame(columns=sorted(need)))
print({LABEL[lg]: f"{int(g['played'].sum()):,} regular-season games played, usage on "
       f"{g.loc[g['played'], 'usage'].notna().mean():.0%}" for lg, g in games.items()},
      f"| {len(listings):,} official listings")""",
    ),
    (
        "code",
        """def pre(x, key):
    \"\"\"The sum over a player's earlier rows of the season (this row excluded).\"\"\"
    return x.groupby(key).cumsum() - x


def frame(lg):
    \"\"\"Every team game a player was on the team for: form so far, share, absence and the team's absences.\"\"\"
    g = games[lg]
    length = GAME_MINUTES[lg]
    sched = g[['season', 'team_id', 'game_id', 'game_date']].drop_duplicates(['season', 'team_id', 'game_id'])
    rows = g[['season', 'player_id', 'team_id', 'game_id', 'game_date', 'played', 'minutes', 'started',
              'fp', 'prod', 'usage']]
    stints = rows.groupby(['season', 'player_id', 'team_id'])['game_date'].agg(first='min', last='max').reset_index()
    last_team = rows.sort_values(['game_date', 'game_id']).groupby(['season', 'player_id'])['team_id'].last()
    is_last = pd.Series(list(zip(stints['season'], stints['player_id'], strict=True))).map(last_team).to_numpy()
    team_end = sched.groupby(['season', 'team_id'])['game_date'].max()
    ends = pd.Series(list(zip(stints['season'], stints['team_id'], strict=True))).map(team_end).to_numpy()
    stints['end'] = np.where(is_last == stints['team_id'].to_numpy(), ends, stints['last'])
    m = stints[['season', 'player_id', 'team_id', 'first', 'end']].merge(sched, on=['season', 'team_id'])
    m = m[(m['game_date'] >= m['first']) & (m['game_date'] <= m['end'])].drop(columns=['first', 'end'])
    m = m.merge(rows.drop(columns=['game_date']), on=['season', 'player_id', 'team_id', 'game_id'], how='left')
    m['played'] = m['played'].astype('boolean').fillna(False).astype(bool)
    m = m.sort_values(['season', 'player_id', 'game_date', 'game_id']).reset_index(drop=True)
    key = [m['season'], m['player_id']]
    on = m['played']
    has_usage = on & m['usage'].notna()
    m['pre_games'] = pre(on.astype(int), key)
    m['pre_min'] = pre(m['minutes'].where(on, 0).fillna(0), key)
    m['pre_fp'] = pre(m['fp'].where(on, 0).fillna(0), key)
    m['pre_prod'] = pre(m['prod'].where(on, 0).fillna(0), key)
    m['pre_starts'] = pre((m['started'].astype('boolean').fillna(False) & on).astype(int), key)
    umin = pre((m['usage'] * m['minutes']).where(has_usage, 0).fillna(0), key)
    umin_n = pre(m['minutes'].where(has_usage, 0).fillna(0), key)
    m['pre_mpg'] = m['pre_min'] / m['pre_games'].replace(0, np.nan)
    m['pre_usage'] = umin / umin_n.replace(0, np.nan)
    # last season's figures stand in before a player's fifth game
    p = g[g['played']]
    last = p.assign(um=p['usage'] * p['minutes'], un=p['minutes'].where(p['usage'].notna())).groupby(
        ['season', 'player_id']).agg(mpg=('minutes', 'mean'), um=('um', 'sum'), un=('un', 'sum'))
    last['usage'] = last['um'] / last['un'].replace(0, np.nan)
    seasons = sorted(g['season'].unique())
    before = dict(zip(seasons[1:], seasons[:-1], strict=False))
    prev_key = pd.MultiIndex.from_arrays([m['season'].map(before), m['player_id']])
    prev_mpg = last['mpg'].reindex(prev_key).to_numpy()
    prev_usage = last['usage'].reindex(prev_key).to_numpy()
    early = (m['pre_games'] < 5).to_numpy()
    mpg = np.where(early & ~np.isnan(prev_mpg), prev_mpg, m['pre_mpg'])
    usg = np.where(early & ~np.isnan(prev_usage), prev_usage, m['pre_usage'])
    mpg = np.nan_to_num(mpg.astype(float))
    usg = np.where(np.isnan(usg.astype(float)), TYPICAL_USAGE, usg.astype(float))
    m['min_share'] = mpg / (5 * length)
    m['usg_share'] = usg * mpg / length
    # absent, and known to be out in advance
    m['out'] = ~m['played']
    prev_out = m.groupby(['season', 'player_id', 'team_id'])['out'].shift(1)
    m['out_known'] = m['out'] & prev_out.astype('boolean').fillna(False).astype(bool)
    m['by_listing'] = False
    lst = listings[listings['league'] == lg]
    if len(lst):
        covered = m['game_id'].isin(set(lst['game_id']))
        listed_out = pd.MultiIndex.from_frame(m[['game_id', 'player_id']]).isin(
            pd.MultiIndex.from_frame(lst.loc[lst['status'] == 'Out', ['game_id', 'player_id']]))
        m.loc[covered, 'out_known'] = m.loc[covered, 'out'] & listed_out[covered.to_numpy()]
        m['by_listing'] = covered
    m['pos'] = m['player_id'].map(positions.get(lg, pd.Series(dtype=str))).fillna('F')
    m.loc[~m['pos'].isin(['G', 'F', 'C']), 'pos'] = 'F'
    m['role'] = np.where(m['pre_starts'] >= 0.5 * m['pre_games'], 'starter', 'bench')
    return new_absence(m)


class Team:
    \"\"\"One team-season as matrices over its games (rows, in order) and players (columns).\"\"\"

    def __init__(self, part):
        self.games = part.drop_duplicates('game_id').sort_values(['game_date', 'game_id'])
        self.dates = self.games['game_date'].to_numpy()
        self.players = np.array(sorted(part['player_id'].unique()))
        gi = pd.Index(self.games['game_id']).get_indexer(part['game_id'])
        pi = pd.Index(self.players).get_indexer(part['player_id'])
        shape = (len(self.games), len(self.players))
        self.played, self.out, self.known = (np.zeros(shape, bool) for _ in range(3))
        self.min_share, self.usg_share = np.zeros(shape), np.zeros(shape)
        self.played[gi, pi] = part['played'].to_numpy()
        self.out[gi, pi] = part['out'].to_numpy()
        self.known[gi, pi] = part['out_known'].to_numpy()
        self.min_share[gi, pi] = part['min_share'].to_numpy()
        self.usg_share[gi, pi] = part['usg_share'].to_numpy()
        pos = part.drop_duplicates('player_id').set_index('player_id')['pos'].reindex(self.players).to_numpy()
        self.same = pos[:, None] == pos[None, :]
        np.fill_diagonal(self.same, False)
        self.other = ~self.same
        np.fill_diagonal(self.other, False)
        self.rows = (gi, pi, part.index.to_numpy())

    def split(self, absent, share, seen):
        \"\"\"Sum over absent teammates j of share_j x the share of player i's games in `seen` that j played.

        absent, share: (players,) for the game; seen: (players i, games) weights over the games
        that make each player's usual mix. Returns same-position and other-position sums per i.
        \"\"\"
        n = seen.sum(axis=1, keepdims=True)
        with_j = np.divide(seen @ self.played, n, out=np.zeros((len(self.players), len(self.players))), where=n > 0)
        new = (absent * share)[None, :] * with_j
        return (new * self.same).sum(axis=1), (new * self.other).sum(axis=1)


def new_absence(m):
    \"\"\"Per row, the known-out share of the team the player's own season so far does not already hold.\"\"\"
    cols = {f'd_{s}_{p}': np.zeros(len(m)) for s in ('min', 'usg') for p in ('pos', 'oth')}
    teams = {}
    for k, part in m.groupby(['season', 'team_id'], sort=False):
        t = Team(part)
        teams[k] = t
        gi, pi, idx = t.rows
        before = np.zeros((len(t.players), len(t.games)))  # games each player played with the team so far
        out = {c: np.zeros(t.played.shape) for c in cols}
        for g in range(len(t.games)):
            for s, share in (('min', t.min_share[g]), ('usg', t.usg_share[g])):
                same, other = t.split(t.known[g], share, before)
                out[f'd_{s}_pos'][g], out[f'd_{s}_oth'][g] = same, other
            before[:, g] = t.played[g]
        for c in cols:
            cols[c][m.index.get_indexer(idx)] = out[c][gi, pi]
    for c, v in cols.items():
        m[c] = v
    return m, teams


frames, teams = {}, {}
for lg in games:
    frames[lg], teams[lg] = frame(lg)
for lg, m in frames.items():
    out = m[m['out']]
    print(f"{LABEL[lg]}: {len(m):,} player-team-games, {len(out):,} absences, "
          f"{out['out_known'].mean() if len(out) else 0:.0%} of them known in advance "
          f"({m['by_listing'].mean():.0%} of player-games on an official listing)")""",
    ),
    (
        "md",
        """## (a) Game by game: what a known absence does to the players left

Slopes are per 10 points of the team's minutes or usage share known out, beyond what the player's
average already holds. An NBA teammate playing 24 of 240 minutes is 10 points of minutes. A
teammate using 30% of possessions over 35 minutes is about 22 points of usage share. Same
position means teammates at the player's position (G, F or C); other means everyone else. The
latest season's estimate comes with its 95% interval, and the earlier seasons' estimate shows
whether it replicates. The out-of-sample gain is the share of the outcome's game-to-game swing
the absence explains in the latest season, with the fit from the earlier seasons, against a
model that has only an intercept.""",
    ),
    (
        "code",
        """OUTCOMES = {
    'minutes_diff': ('Minutes vs own average', ['d_min_pos', 'd_min_oth']),
    'usage_diff': ('Usage (pts) vs own average', ['d_usg_pos', 'd_usg_oth']),
    'fp36_diff': ('Fantasy pts per 36 min vs own rate', ['d_usg_pos', 'd_usg_oth']),
    'fp_diff': ('Fantasy pts per game vs own average', ['d_usg_pos', 'd_usg_oth']),
    'prod_diff': ('Production per game vs own average', ['d_usg_pos', 'd_usg_oth']),
}
GROUPS = {'all': 'All', 'starter': 'Starters', 'bench': 'Bench', 'G': 'Guards', 'F': 'Forwards', 'C': 'Centres'}
PER = 0.10  # slopes per 10 points of share


def model_rows(m, outcome):
    r = m[m['played'] & (m['pre_games'] >= 5) & (m['pre_mpg'] >= 10)].copy()
    r['minutes_diff'] = r['minutes'] - r['pre_mpg']
    r['usage_diff'] = 100 * (r['usage'] - r['pre_usage'])
    r['fp36_diff'] = 36 * (r['fp'] / r['minutes'] - r['pre_fp'] / r['pre_min'])
    r['fp_diff'] = r['fp'] - r['pre_fp'] / r['pre_games']
    r['prod_diff'] = r['prod'] - r['pre_prod'] / r['pre_games']
    if outcome in ('usage_diff', 'fp36_diff'):
        r = r[r['minutes'] >= 10]
    return r.dropna(subset=[outcome, *OUTCOMES[outcome][1]])


def group(r, name):
    if name == 'all':
        return r
    return r[r['role'] == name] if name in ('starter', 'bench') else r[r['pos'] == name]


def ols(X, y, w=None):
    if w is not None:
        s = np.sqrt(w)
        X, y = X * s[:, None], y * s
    return np.linalg.lstsq(X, y, rcond=None)[0]


def fit(r, outcome, test_season, reps=100, seed=11):
    feats = OUTCOMES[outcome][1]
    train, test = r[r['season'] < test_season], r[r['season'] == test_season]
    out = {'n_train': len(train), 'n_test': len(test)}
    if len(train) >= 200:
        Xr = np.c_[np.ones(len(train)), train[feats].to_numpy(float)]
        out['beta_train'] = ols(Xr, train[outcome].to_numpy(float))
    if len(test) < 200:
        return out
    Xt = np.c_[np.ones(len(test)), test[feats].to_numpy(float)]
    yt = test[outcome].to_numpy(float)
    out['beta_test'] = ols(Xt, yt)
    rng = np.random.default_rng(seed)
    _, inv = np.unique(test['player_id'].to_numpy(), return_inverse=True)
    draws = np.array([ols(Xt, yt, rng.poisson(1.0, inv.max() + 1)[inv].astype(float)) for _ in range(reps)])
    out['lo'], out['hi'] = np.quantile(draws, 0.025, axis=0), np.quantile(draws, 0.975, axis=0)
    out['affected_share'] = float((test[feats].abs().sum(axis=1) > 0.02).mean())
    if 'beta_train' in out:
        b = out['beta_train']
        base = train[outcome].mean()
        out['oos_gain'] = 1 - ((yt - Xt @ b) ** 2).sum() / ((yt - base) ** 2).sum()
    return out


fits, tests = {}, {}
for lg, m in frames.items():
    seasons = [s for s in done[lg] if ((m['season'] == s) & m['played']).sum() >= 1000]
    if len(seasons) < 2:
        continue
    tests[lg] = seasons[-1]
    for outcome in OUTCOMES:
        r = model_rows(m, outcome)
        r = r[r['season'] <= tests[lg]]
        for name in GROUPS:
            fits[(lg, outcome, name)] = fit(group(r, name), outcome, tests[lg])

rows = []
for (lg, outcome, name), f in fits.items():
    if 'beta_test' not in f:
        continue
    for i, feat in enumerate(OUTCOMES[outcome][1], start=1):
        rows.append({'league': lg, 'outcome': OUTCOMES[outcome][0], 'group': GROUPS[name],
                     'teammates': 'same position' if feat.endswith('pos') else 'other positions',
                     'estimate': f['beta_test'][i] * PER, 'lo': f['lo'][i] * PER, 'hi': f['hi'][i] * PER,
                     'earlier_seasons': f['beta_train'][i] * PER if 'beta_train' in f else np.nan,
                     'oos_gain_pct': 100 * f.get('oos_gain', np.nan), 'n_test': f['n_test']})
slopes = pd.DataFrame(rows)
for lg in tests:
    print(f"{LABEL[lg]}: slopes per 10 points of share, {tests[lg]} (earlier seasons alongside)")
    display(slopes[slopes['league'] == lg].drop(columns='league').round(3))
if not len(slopes):
    print('Not enough finished seasons in this build to fit on earlier seasons and test on the latest.')""",
    ),
    (
        "code",
        """if len(slopes):
    fig, axes = plt.subplots(1, len(tests), figsize=(7 * len(tests), 5), squeeze=False)
    for ax, lg in zip(axes[0], tests, strict=False):
        e = slopes[(slopes['league'] == lg) & (slopes['outcome'] == OUTCOMES['fp_diff'][0])].reset_index(drop=True)
        labels = e['group'] + ', ' + e['teammates']
        ax.errorbar(e['estimate'], range(len(e)), xerr=[e['estimate'] - e['lo'], e['hi'] - e['estimate']],
                    fmt='o', color=COLOR[lg])
        ax.scatter(e['earlier_seasons'], range(len(e)), marker='x', color='grey', label='earlier seasons')
        ax.set_yticks(range(len(e)), labels)
        ax.axvline(0, color='grey', lw=1)
        ax.set_xlabel('Fantasy points per game, per 10 points of usage share out (95% interval)')
        ax.set_title(f'{LABEL[lg]} {tests[lg]}')
        ax.legend(fontsize=8)
    plt.tight_layout()
    plt.show()""",
    ),
    (
        "md",
        """## (b) Monday replays: does the adjustment beat the last ten games?

Each Monday's affected players are those whose team's top teammate is known out for the whole
week. The redistribution slopes are the game-by-game fit on the earlier seasons, all players,
by role. The latest season's errors are out of sample for every predictor.""",
    ),
    (
        "code",
        """TARGETS = {'fp': 'Fantasy pts per game', 'prod': 'Production per game', 'minutes': 'Minutes per game'}
TARGET_OUTCOME = {'fp': 'fp_diff', 'prod': 'prod_diff', 'minutes': 'minutes_diff'}
SHRINK = 5  # games: the player's own with/without split is shrunk toward no gap


def mondays(m, season):
    dates = m.loc[m['season'] == season, 'game_date']
    if dates.empty:
        return []
    first, last = dates.min(), dates.max()
    return [d for d in pd.date_range(first + pd.Timedelta(days=7), last, freq='W-MON')
            if d + pd.Timedelta(days=6) <= last]


def slopes_for(lg, role):
    \"\"\"The game-by-game slopes fitted on the earlier seasons, per target and role.\"\"\"
    out = {}
    for t, outcome in TARGET_OUTCOME.items():
        f = fits.get((lg, outcome, role), {})
        out[t] = f['beta_train'][1:] if 'beta_train' in f else np.zeros(2)
    return out


def replay_weeks(lg):
    \"\"\"Every Monday, the players of each team whose top teammate is known out for the whole week.\"\"\"
    m = frames[lg]
    played = m[m['played']].copy()
    for c in ('fp', 'prod', 'minutes'):
        played[f'r10_{c}'] = played.groupby(['season', 'player_id'])[c].transform(
            lambda x: x.rolling(10, min_periods=1).mean())
    out, counts = [], []
    for season in sorted(m['season'].unique()):
        ms = m[m['season'] == season]
        ps = played[played['season'] == season]
        for monday in mondays(m, season):
            end = monday + pd.Timedelta(days=7)
            wk = ms[(ms['game_date'] >= monday) & (ms['game_date'] < end)]
            if wk.empty:
                continue
            first = wk.sort_values(['game_date', 'game_id']).drop_duplicates(['player_id', 'team_id']).copy()
            first['week_games'] = first.set_index(['player_id', 'team_id']).index.map(
                wk.groupby(['player_id', 'team_id'])['played'].sum()).to_numpy()
            first['out_week'] = first['out_known'] & (first['week_games'] == 0)
            cand = first[first['pre_games'] >= 5]
            top = cand.sort_values('usg_share', ascending=False).drop_duplicates('team_id').set_index('team_id')
            counts.append(len(top))
            last10 = ps[ps['game_date'] < monday].groupby('player_id').tail(1).set_index('player_id')
            nxt = wk[wk['played']].groupby('player_id')[['fp', 'prod', 'minutes']].mean().add_prefix('next_')
            for team_id, tp in top[top['out_week']].iterrows():
                f = first[first['team_id'] == team_id].set_index('player_id')
                r = f[(f['pre_games'] >= 5) & (f['week_games'] > 0) & (f.index != tp['player_id'])].copy()
                if r.empty:
                    continue
                t = teams[lg][(season, team_id)]
                ti = pd.Index(t.players)
                at = ti.get_indexer(f.index)
                absent = np.zeros(len(ti))
                absent[at] = f['out_week'].to_numpy()
                # each player's last ten games with the team before Monday make the usual mix
                seen = np.zeros((len(ti), len(t.games)))
                early = t.dates < np.datetime64(monday)
                for i in range(len(ti)):
                    seen[i, np.flatnonzero(early & t.played[:, i])[-10:]] = 1
                for s in ('min', 'usg'):
                    share = np.zeros(len(ti))
                    share[at] = f[f'{s}_share'].to_numpy()
                    same, other = t.split(absent, share, seen)
                    r[f'd_{s}_pos'] = same[ti.get_indexer(r.index)]
                    r[f'd_{s}_oth'] = other[ti.get_indexer(r.index)]
                # the player's own split with and without the top teammate, this season so far
                k = ti.get_loc(tp['player_id'])
                for t_ in TARGETS:
                    r[f'own_{t_}'] = 0.0
                prior = ms[(ms['team_id'] == team_id) & (ms['game_date'] < monday) & ms['played']
                           & ms['player_id'].isin(r.index)]
                with_top = prior['game_id'].map(dict(zip(t.games['game_id'], t.played[:, k], strict=True)))
                for pid, mine in prior.groupby('player_id'):
                    w_top = with_top.loc[mine.index].astype(bool)
                    n_wo = int((~w_top).sum())
                    if n_wo == 0 or w_top.sum() == 0:
                        continue
                    recent = w_top.iloc[-10:].mean()  # the last ten games already lack the teammate in part
                    for t_ in TARGETS:
                        gap = mine.loc[~w_top, t_].mean() - mine.loc[w_top, t_].mean()
                        r.loc[pid, f'own_{t_}'] = gap * n_wo / (n_wo + SHRINK) * recent
                r = r.join(last10[['r10_fp', 'r10_prod', 'r10_minutes']]).join(nxt)
                r = r.assign(league=lg, season=season, monday=monday, top_id=tp['player_id'],
                             top_share=tp['usg_share'])
                out.append(r.rename_axis('player_id').reset_index())
    return (pd.concat(out, ignore_index=True) if out else pd.DataFrame()), sum(counts)


weeks = {}
for lg in tests:
    w, team_weeks = replay_weeks(lg)
    weeks[lg] = w
    if not len(w):
        continue
    for t in TARGETS:
        w[f'adj_{t}'] = 0.0
        feats = ['d_min_pos', 'd_min_oth'] if t == 'minutes' else ['d_usg_pos', 'd_usg_oth']
        for role in ('starter', 'bench'):
            sel = w['role'] == role
            w.loc[sel, f'adj_{t}'] = w.loc[sel, feats].to_numpy(float) @ slopes_for(lg, role)[t]
    w['new_usage'] = w['d_usg_pos'] + w['d_usg_oth']
    print(f"{LABEL[lg]}: {w.groupby(['monday', 'team_id']).ngroups} team-weeks of {team_weeks:,} with the top teammate "
          f"out all week; {len(w):,} affected player-weeks")
    display(w.groupby('season').agg(player_weeks=('player_id', 'size'), team_weeks=('top_id', 'size'),
                                    top_usage_share=('top_share', 'mean'), new_usage_share=('new_usage', 'mean'),
                                    fresh=('new_usage', lambda x: (x > 0.05).mean())).round(3))""",
    ),
    (
        "code",
        """def mae_table(part, shift, reps=200, seed=7):
    \"\"\"Errors of each predictor per target, with a player-bootstrap interval of its gain in mean absolute error.

    shift: per target, the average change from the last ten over the earlier seasons' affected weeks.
    \"\"\"
    rows = []
    _, inv = np.unique(part['player_id'].to_numpy(), return_inverse=True)
    rng = np.random.default_rng(seed)
    w = rng.poisson(1.0, (reps, inv.max() + 1))[:, inv].astype(float) if len(part) else np.zeros((reps, 0))
    for t, label in TARGETS.items():
        y = part[f'next_{t}'].to_numpy(float)
        base = part[f'r10_{t}'].to_numpy(float)
        adj = part[f'adj_{t}'].to_numpy(float)
        preds = {'Last ten': base,
                 'Last ten plus the average uplift': base + shift.get(t, 0.0),
                 'Last ten plus redistribution': base + adj,
                 'Last ten plus their own split': base + part[f'own_{t}'].fillna(0).to_numpy(float)}
        e0 = np.abs(y - base)
        change = y - base
        for name, p in preds.items():
            e = np.abs(y - p)
            ok = ~np.isnan(e) & ~np.isnan(e0)
            gain = (w[:, ok] @ (e0[ok] - e[ok])) / w[:, ok].sum(axis=1)
            moved = p - base
            corr = np.corrcoef(moved[ok], change[ok])[0, 1] if ok.sum() > 2 and np.ptp(moved[ok]) > 1e-9 else np.nan
            rows.append({'target': label, 'predictor': name, 'mae': e[ok].mean(), 'rmse': np.sqrt(((y - p)[ok] ** 2).mean()),
                         'bias': (p - y)[ok].mean(), 'gain_vs_last_ten': (e0[ok] - e[ok]).mean(),
                         'gain_lo': np.quantile(gain, 0.025), 'gain_hi': np.quantile(gain, 0.975),
                         'corr_with_change': corr, 'n': int(ok.sum())})
    return pd.DataFrame(rows)


replays = {}
for lg, w in weeks.items():
    if not len(w):
        continue
    test = w[w['season'] == tests[lg]]
    early = w[w['season'] < tests[lg]]
    fresh = test[test['new_usage'] > 0.05]
    shift = {t: float((early[f'next_{t}'] - early[f'r10_{t}']).mean()) if len(early) else 0.0 for t in TARGETS}
    replays[lg] = {'test': mae_table(test, shift) if len(test) >= 30 else pd.DataFrame(),
                   'earlier': mae_table(early, shift) if len(early) >= 30 else pd.DataFrame(),
                   'fresh': mae_table(fresh, shift) if len(fresh) >= 30 else pd.DataFrame(),
                   'n_test': len(test), 'n_earlier': len(early), 'n_fresh': len(fresh)}
    for part in ('test', 'fresh', 'earlier'):
        t = replays[lg][part]
        if len(t):
            title = {'test': f'{tests[lg]}, every affected player-week',
                     'fresh': f'{tests[lg]}, absences the last ten games do not hold (more than 5 points of usage share new)',
                     'earlier': 'earlier seasons (the redistribution slopes were fitted on these)'}[part]
            print(f"{LABEL[lg]}: {title}")
            display(t.round(3))
if not replays:
    print('No league in this build has a finished season to test on with earlier seasons to fit.')""",
    ),
    (
        "md",
        """## Reading the replay

The average uplift is the earlier seasons' average change from the last ten for affected players,
the same for everyone. If the redistribution does no better than that flat amount, it knows that
affected players gain on average but not which of them gain. The correlation column is the
correlation of each predictor's move away from the last ten with the change that followed.""",
    ),
    (
        "code",
        """for lg in LEAGUES:
    if lg not in tests or lg not in replays or not len(replays[lg]['test']):
        n = int(frames[lg]['played'].sum()) if lg in frames else 0
        findings[lg] = insufficient(
            f"Not enough history in this build: the {LABEL[lg]} study needs a finished season to test on, "
            "earlier seasons to fit on and Mondays when a team's top player was out all week.",
            n=n, n_label='player-games')
        continue
    test = tests[lg]
    res = replays[lg]
    t = res['test'].set_index(['target', 'predictor'])
    fp = 'Fantasy pts per game'
    base, adj = t.loc[(fp, 'Last ten')], t.loc[(fp, 'Last ten plus redistribution')]
    flat, own = t.loc[(fp, 'Last ten plus the average uplift')], t.loc[(fp, 'Last ten plus their own split')]
    prod = t.loc[('Production per game', 'Last ten plus redistribution')]

    def pick(outcome, who):
        r = slopes[(slopes['league'] == lg) & (slopes['outcome'] == OUTCOMES[outcome][0]) & (slopes['group'] == 'All')
                   & (slopes['teammates'] == who)]
        return f"{r['estimate'].iloc[0]:+.2f} ({r['lo'].iloc[0]:+.2f} to {r['hi'].iloc[0]:+.2f})" if len(r) else 'n/a'

    def gain(row):
        return f"{row['gain_vs_last_ten']:+.2f} ({row['gain_lo']:+.2f} to {row['gain_hi']:+.2f})"

    clear = adj['gain_lo'] > 0 and prod['gain_lo'] > 0
    headline = (f"In {test}, players whose top teammate was out all week scored {-base['bias']:+.1f} fantasy points a game "
                f"against their last ten, and the redistribution moved them {adj['bias'] - base['bias']:+.1f} on average. "
                f"Its gain in mean absolute error on the last ten was {gain(adj)} points, "
                + ("a gain clear of the noise" if clear else "inside the noise")
                + f"; its moves correlated {adj['corr_with_change']:.2f} with the change that followed.")
    facts = [
        {'label': f'Affected player-weeks, {test}', 'value': f"{res['n_test']:,} ({res['n_fresh']:,} with 5+ points of usage share newly out)"},
        {'label': 'Minutes per 10 pts of team minutes out (same position / other)', 'value': f"{pick('minutes_diff', 'same position')} / {pick('minutes_diff', 'other positions')}"},
        {'label': 'Usage (pts) per 10 pts of usage share out (same position / other)', 'value': f"{pick('usage_diff', 'same position')} / {pick('usage_diff', 'other positions')}"},
        {'label': 'Fantasy pts per game per 10 pts of usage share out (same / other)', 'value': f"{pick('fp_diff', 'same position')} / {pick('fp_diff', 'other positions')}"},
        {'label': 'Fantasy pts a game: error gain, flat uplift / redistribution / own split', 'value': f"{gain(flat)} / {gain(adj)} / {gain(own)}"},
        {'label': 'Redistribution vs the change that followed, correlation', 'value': f"{adj['corr_with_change']:.2f} (fantasy pts), {prod['corr_with_change']:.2f} (production)"},
    ]
    table = res['test']
    findings[lg] = {
        'headline': headline,
        'facts': facts,
        'table': {'columns': ['Target', 'Predictor', f'Mean abs. error, {test}', 'Gain on last ten', '95% interval', 'Bias'],
                  'rows': [[r['target'], r['predictor'], round(r['mae'], 3), round(r['gain_vs_last_ten'], 3),
                            f"{r['gain_lo']:+.3f} to {r['gain_hi']:+.3f}", round(r['bias'], 3)]
                           for _, r in table.iterrows() if r['predictor'] != 'Last ten' or r['target'] == fp]},
        'n': int(res['n_test']),
        'n_label': f'affected player-weeks in {test}',
    }
save_findings('07_teammate_absence', {'title': 'Teammate absence', 'leagues': findings})
findings""",
    ),
]
