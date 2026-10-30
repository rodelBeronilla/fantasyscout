"""03_game_context: do rest, travel and the opponent change whether and how a regular plays?"""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Game context: rest, travel, altitude and the opponent

**The question.** Streamers and the schedule show back-to-backs, three games in four nights,
miles travelled, time zones, altitude and the opponent's rest beside every game, and the
matchup value carries the opponent's defence and pace. Do any of them change (i) whether a
regular plays at all and (ii) how many minutes they get and what they produce per minute?

**Why it matters.** A manager setting a daily lineup or choosing between two streamers wants to
know which of these flags is worth acting on. A second-night rest day costs a whole game; a
small dip per minute costs little. The same data answer a second question the board relies on:
once a player has missed a game, how likely is the next one missed too? The board charges a
day-to-day listing a quarter of a game, questionable half and doubtful three quarters.""",
    ),
    (
        "md",
        """## Method

- **Regulars.** Every regular-season team game a player was on the team for (from the first
  listing with the team to the last, or to the season's end for the player's last team), with
  five or more games played before it and 10 or more minutes per game so far. A game the player
  is not listed for, or listed and did not play, is a missed game. Minutes tiers use the minutes
  per game before the game.
- **Outcomes.** Missed the game (in percentage points); minutes against the player's average so
  far; and fantasy points per 30 minutes against the player's own rate so far, for games of 10+
  minutes (ESPN's default points: PTS + REB + 2 AST + 4 STL + 4 BLK + 3PM - 2 TO + 2 FGM - FGA +
  FTM - FTA).
- **Context.** Rest (back-to-back, third game in four nights, the opponent on a back-to-back) is
  derived from every team's game dates, so it covers every season; it is checked against
  `fct_team_game_context` where that table has the game. Travel, time zones and altitude come
  only from `fct_team_game_context`. The opponent's defensive rating and pace are its averages
  before the game, with last season counted as 10 games (as the matchup value does), standardised
  over the league's teams.
- **Out of sample.** One linear model per outcome, with the minutes tier as a control, is fitted
  on the earlier seasons and estimated again on the latest finished season. The effect sizes
  reported are the latest season's, with 95% intervals from resampling players; the earlier
  seasons' estimate shows whether it replicates. The share of the outcome's variance the context
  explains out of sample is measured against a model with the minutes tier alone.
- **Missed games.** The hazard of missing the next team game after missing exactly k in a row,
  for players with 10 or more games and 15 or more minutes a game so far.""",
    ),
    setup(),
    (
        "code",
        """import replay as rp

FP = {'points': 1, 'rebounds_total': 1, 'assists': 2, 'steals': 4, 'blocks': 4, 'three_pointers_made': 1,
      'turnovers': -2, 'fgm': 2, 'fga': -1, 'ftm': 1, 'fta': -1}
cols = ', '.join((*rp.GAME_COLUMNS, 'comment', 'is_home'))
games = {}
for lg in LEAGUES:
    g = con.sql(f"select {cols} from fct_player_game where league = '{lg}'").df()
    if len(g):
        g = rp.prepare(g)
        g['fp'] = sum(w * g[c].fillna(0) for c, w in FP.items())
        games[lg] = g

ctx_cols = ['league', 'season', 'game_id', 'team_id', 'game_type', 'rest_days', 'is_back_to_back', 'is_3_in_4',
            'miles_travelled', 'time_zones_crossed', 'elevation_ft', 'at_altitude', 'opponent_back_to_back']
have = columns(con, 'fct_team_game_context')
ctx = (con.sql(f"select {', '.join(c for c in ctx_cols if c in have)} from fct_team_game_context").df()
       if set(ctx_cols) <= have else pd.DataFrame(columns=ctx_cols))
tg_cols = ['league', 'season', 'game_id', 'game_date', 'team_id', 'defensive_rating', 'pace']
ratings = (con.sql(f"select {', '.join(tg_cols)} from fct_team_game").df()
           if set(tg_cols) <= columns(con, 'fct_team_game') else pd.DataFrame(columns=tg_cols))
print({LABEL[lg]: f"{len(g):,} player-games" for lg, g in games.items()}, f"| {len(ctx):,} team-games with context",
      f"| {len(ratings):,} team-games with ratings")""",
    ),
    (
        "md",
        """## Coverage of the context fields by season

The share of each season's team-games with the field filled in, counting only games after a
team's first of the season (the first has no previous game to rest or travel from). A season
missing here has no landed schedule with arena cities; a low share names cities the venue seed
does not place.""",
    ),
    (
        "code",
        """if len(ctx):
    c = ctx[ctx['game_type'] == 'regular'].copy()
    c['after_first'] = c['rest_days'].notna()
    coverage = c.groupby(['league', 'season']).apply(lambda x: pd.Series({
        'team_games': len(x),
        'rest_days': x['rest_days'].notna().mean(),
        'miles_travelled': x.loc[x['after_first'], 'miles_travelled'].notna().mean() if x['after_first'].any() else np.nan,
        'time_zones_crossed': x.loc[x['after_first'], 'time_zones_crossed'].notna().mean() if x['after_first'].any() else np.nan,
        'elevation_ft': x['elevation_ft'].notna().mean(),
    }), include_groups=False)
    display(coverage.round(3))
else:
    coverage = pd.DataFrame()
    print('This build has no fct_team_game_context rows.')""",
    ),
    (
        "code",
        """def team_schedule(g):
    \"\"\"Each regular-season team game with rest derived from the team's game dates.\"\"\"
    s = g[g['regular']][['season', 'team_id', 'game_id', 'game_date']].drop_duplicates(['season', 'team_id', 'game_id'])
    s = s.sort_values(['season', 'team_id', 'game_date', 'game_id'])
    prev = s.groupby(['season', 'team_id'])['game_date'].shift(1)
    s['rest'] = (s['game_date'] - prev).dt.days - 1
    s['b2b'] = (s['rest'] == 0).astype(float)
    back2 = s.groupby(['season', 'team_id'])['game_date'].shift(2)
    s['three_in_four'] = ((s['game_date'] - back2).dt.days <= 3).astype(float)
    opp = s[['season', 'game_id', 'team_id', 'b2b', 'rest']].rename(columns={'team_id': 'opponent_id', 'b2b': 'opp_b2b', 'rest': 'opp_rest'})
    s = s.merge(opp, on=['season', 'game_id'])
    return s[s['team_id'] != s['opponent_id']]


def opponent_ratings(lg):
    \"\"\"Each team's defence and pace before a game, last season counted as 10 games, standardised.\"\"\"
    t = ratings[ratings['league'] == lg].copy()
    if t.empty:
        return pd.DataFrame(columns=['season', 'game_id', 'team_id', 'opp_def_z', 'pace_z'])
    t['game_date'] = pd.to_datetime(t['game_date'])
    t = t.sort_values(['season', 'team_id', 'game_date', 'game_id'])
    seasons = sorted(t['season'].unique())
    prev_mean = t.groupby(['season', 'team_id'])[['defensive_rating', 'pace']].mean()
    out = []
    for season, part in t.groupby('season'):
        part = part.copy()
        grp = part.groupby('team_id')
        n = grp.cumcount()
        earlier = [s for s in seasons if s < season]
        for c in ['defensive_rating', 'pace']:
            to_date = grp[c].transform(lambda x: x.shift(1).expanding().mean())
            last = part['team_id'].map(prev_mean.loc[earlier[-1], c]) if earlier else pd.Series(np.nan, index=part.index)
            blended = (n * to_date.fillna(0) + 10 * last) / (n + 10)
            part[c + '_asof'] = blended.where(last.notna(), to_date)
        out.append(part)
    t = pd.concat(out)
    for c, z in [('defensive_rating_asof', 'opp_def_z'), ('pace_asof', 'pace_z')]:
        t[z] = t.groupby('season')[c].transform(lambda x: (x - x.mean()) / x.std())
    return t[['season', 'game_id', 'team_id', 'opp_def_z', 'pace_z']]


def regulars(lg):
    \"\"\"Every team game a player was on the team for, with what the player had done before it.\"\"\"
    g = games[lg]
    reg = g[g['regular']]
    sched = team_schedule(g)
    rows = reg[['season', 'player_id', 'team_id', 'game_id', 'game_date', 'played', 'minutes', 'comment', 'fp']]
    stints = rows.groupby(['season', 'player_id', 'team_id'])['game_date'].agg(first='min', last='max').reset_index()
    last_team = rows.sort_values(['game_date', 'game_id']).groupby(['season', 'player_id'])['team_id'].last()
    stints['last_team'] = list(zip(stints['season'], stints['player_id'], strict=True))
    stints['last_team'] = stints['last_team'].map(last_team) == stints['team_id']
    team_end = sched.groupby(['season', 'team_id'])['game_date'].max().rename('team_end').reset_index()
    stints = stints.merge(team_end, on=['season', 'team_id'])
    stints['end'] = stints['team_end'].where(stints['last_team'], stints['last'])
    m = stints[['season', 'player_id', 'team_id', 'first', 'end']].merge(sched, on=['season', 'team_id'])
    m = m[(m['game_date'] >= m['first']) & (m['game_date'] <= m['end'])]
    m = m.merge(rows.drop(columns=['game_date']), on=['season', 'player_id', 'team_id', 'game_id'], how='left')
    m['listed'] = m['played'].notna()
    m['played'] = m['played'].fillna(False).astype(bool)
    m['missed'] = (~m['played']).astype(float)
    m = m.sort_values(['season', 'player_id', 'game_date', 'game_id']).reset_index(drop=True)
    key = [m['season'], m['player_id']]
    mins = m['minutes'].where(m['played'], 0).fillna(0)
    fp = m['fp'].where(m['played'], 0).fillna(0)
    m['pre_games'] = m['played'].astype(int).groupby(key).cumsum() - m['played'].astype(int)
    m['pre_min'] = mins.groupby(key).cumsum() - mins
    m['pre_fp'] = fp.groupby(key).cumsum() - fp
    m['pre_mpg'] = m['pre_min'] / m['pre_games'].replace(0, np.nan)
    m['tier'] = pd.cut(m['pre_mpg'], [10, 20, 28, 34, 60], right=False, labels=['10-20', '20-28', '28-34', '34+'])
    m = m.merge(opponent_ratings(lg).rename(columns={'team_id': 'opponent_id'}), on=['season', 'game_id', 'opponent_id'], how='left')
    c = ctx[ctx['league'] == lg]
    if len(c):
        c = c.assign(miles_1000=c['miles_travelled'] / 1000, tz_abs=c['time_zones_crossed'].abs(),
                     altitude=c['at_altitude'].astype(float))
        m = m.merge(c[['season', 'game_id', 'team_id', 'miles_1000', 'tz_abs', 'altitude', 'is_back_to_back']],
                    on=['season', 'game_id', 'team_id'], how='left')
    else:
        m = m.assign(miles_1000=np.nan, tz_abs=np.nan, altitude=np.nan, is_back_to_back=np.nan)
    homes = reg[['season', 'game_id', 'team_id', 'is_home']].drop_duplicates(['season', 'game_id', 'team_id'])
    m = m.merge(homes, on=['season', 'game_id', 'team_id'], how='left')
    m['home'] = m['is_home'].astype(float)
    return m.sort_values(['season', 'player_id', 'game_date', 'game_id']).reset_index(drop=True)


frames = {lg: regulars(lg) for lg in games}
for lg, m in frames.items():
    check = m.dropna(subset=['is_back_to_back'])
    agree = (check['b2b'] == check['is_back_to_back'].astype(float)).mean() if len(check) else np.nan
    print(f"{LABEL[lg]}: {len(m):,} player-team-games; back-to-backs derived from dates agree with "
          f"fct_team_game_context on {agree:.1%} of {len(check):,}" if len(check) else f"{LABEL[lg]}: {len(m):,} player-team-games")""",
    ),
    (
        "code",
        """REST = {'b2b': 'Second night of a back-to-back', 'three_in_four': 'Third game in four nights',
        'opp_b2b': 'Opponent on a back-to-back', 'home': 'At home',
        'opp_def_z': 'Opponent defence, per SD (higher rating = leakier)', 'pace_z': 'Opponent pace, per SD'}
TRAVEL = {'miles_1000': 'Travel, per 1,000 miles', 'tz_abs': 'Time zones crossed, each', 'altitude': 'At altitude (4,000 ft+)'}
OUTCOMES = {'missed': ('Missed the game (pts)', 100), 'minutes_diff': ('Minutes vs own average', 1),
            'fp30_diff': ('Fantasy pts per 30 min vs own rate', 1)}


def model_rows(m, outcome):
    r = m[(m['pre_games'] >= 5) & m['tier'].notna()].copy()
    r['minutes_diff'] = r['minutes'] - r['pre_mpg']
    r['fp30_diff'] = 30 * (r['fp'] / r['minutes'] - r['pre_fp'] / r['pre_min'])
    if outcome != 'missed':
        r = r[r['played']]
    if outcome == 'fp30_diff':
        r = r[r['minutes'] >= 10]
    return r


def design(r, feats):
    tiers = pd.get_dummies(r['tier'], drop_first=True, dtype=float)
    return np.c_[np.ones(len(r)), r[feats].to_numpy(dtype=float), tiers.to_numpy()], np.ones(len(r))


def ols(X, y, w=None):
    if w is not None:
        s = np.sqrt(w)
        X, y = X * s[:, None], y * s
    return np.linalg.lstsq(X, y, rcond=None)[0]


def effects(m, feats, outcome, test_season, reps=100, seed=11):
    r = model_rows(m, outcome).dropna(subset=feats + [outcome])
    train, test = r[r['season'] < test_season], r[r['season'] == test_season]
    out = {'n_train': len(train), 'n_test': len(test)}
    if len(test) < 200:
        return out
    feats = [f for f in feats if test[f].astype(float).std() > 0]  # e.g. no WNBA venue is at altitude
    scale = OUTCOMES[outcome][1]
    Xt, _ = design(test, feats)
    yt = test[outcome].to_numpy(dtype=float)
    beta_test = ols(Xt, yt)
    rng = np.random.default_rng(seed)
    ids = test['player_id'].to_numpy()
    uniq, inv = np.unique(ids, return_inverse=True)
    draws = np.array([ols(Xt, yt, rng.poisson(1.0, len(uniq))[inv].astype(float)) for _ in range(reps)])
    for i, f in enumerate(feats, start=1):
        out[f] = (beta_test[i] * scale, *(np.quantile(draws[:, i], [0.025, 0.975]) * scale))
    if len(train) >= 200:
        Xr, _ = design(train, feats)
        yr = train[outcome].to_numpy(dtype=float)
        beta_train = ols(Xr, yr)
        for i, f in enumerate(feats, start=1):
            out[f + '_train'] = beta_train[i] * scale
        base = ols(np.delete(Xr, range(1, len(feats) + 1), axis=1), yr)
        pred_full = Xt @ beta_train
        pred_base = np.delete(Xt, range(1, len(feats) + 1), axis=1) @ base
        out['oos_r2_gain'] = 1 - ((yt - pred_full) ** 2).sum() / ((yt - pred_base) ** 2).sum()
    return out


def finished(g):
    seasons = sorted(g['season'].unique())
    playoffs = set(g.loc[~g['regular'], 'season'])
    return [s for i, s in enumerate(seasons) if s in playoffs or i < len(seasons) - 1]


results, tests = {}, {}
for lg, m in frames.items():
    done = [s for s in finished(games[lg]) if (m['season'] == s).any()]
    if not done:
        continue
    test = done[-1]
    tests[lg] = test
    for outcome in OUTCOMES:
        rest = effects(m, list(REST), outcome, test)
        travel_ok = m.loc[m['season'] == test, 'miles_1000'].notna().mean() > 0.5
        travel = effects(m, list(REST) + list(TRAVEL), outcome, test) if travel_ok else {}
        results[(lg, outcome)] = {'rest': rest, 'travel': travel}

rows = []
for (lg, outcome), res in results.items():
    for group, feats in [('rest', REST), ('travel', TRAVEL)]:
        e = res[group]
        for f, label in feats.items():
            if f in e:
                est, lo, hi = e[f]
                rows.append({'league': lg, 'outcome': OUTCOMES[outcome][0], 'context': label, 'estimate': est,
                             'lo': lo, 'hi': hi, 'earlier_seasons': e.get(f + '_train'), 'n_test': e['n_test']})
effects_table = pd.DataFrame(rows)
if len(effects_table):
    for lg in tests:
        print(f"{LABEL[lg]}: effects in {tests[lg]}, earlier seasons alongside")
        display(effects_table[effects_table['league'] == lg].drop(columns='league').round(3))
    gains = pd.DataFrame([{'league': lg, 'outcome': OUTCOMES[o][0], 'model': grp, 'oos_r2_gain_pct': 100 * r[grp].get('oos_r2_gain', np.nan)}
                          for (lg, o), r in results.items() for grp in ['rest', 'travel'] if r[grp]])
    print('Share of the outcome explained out of sample beyond the minutes tier (%):')
    display(gains.round(3))""",
    ),
    (
        "code",
        """dnp = {}
for lg, m in frames.items():
    r = model_rows(m, 'missed')
    if len(r) < 200:
        continue
    t = r.groupby(['tier', 'b2b'], observed=True)['missed'].agg(['mean', 'size']).unstack('b2b')
    dnp[lg] = t
    print(f"{LABEL[lg]}: share of games missed by minutes tier, second night of a back-to-back (1.0) or not (0.0)")
    display(t.round(3))
if effects_table.shape[0]:
    fig, axes = plt.subplots(1, len(tests), figsize=(6.5 * len(tests), 4.5), squeeze=False)
    for ax, lg in zip(axes[0], tests, strict=False):
        e = effects_table[(effects_table['league'] == lg) & (effects_table['outcome'] == OUTCOMES['fp30_diff'][0])]
        ax.errorbar(e['estimate'], range(len(e)), xerr=[e['estimate'] - e['lo'], e['hi'] - e['estimate']], fmt='o', color=COLOR[lg])
        ax.set_yticks(range(len(e)), e['context'])
        ax.axvline(0, color='grey', lw=1)
        ax.set_xlabel('Fantasy points per 30 minutes (95% interval)')
        ax.set_title(f'{LABEL[lg]} {tests[lg]}: production per minute')
    plt.tight_layout()
    plt.show()""",
    ),
    (
        "md",
        """## Once a player has missed a game

The hazard is the share of players who miss the next team game, given they have missed exactly
k in a row just before it. The expected further games missed after a first miss adds up the
chance of each further game in the streak. A player who sat because of the coach (a DNP with the
coach's decision) is split from one sat with an injury or illness and from one not listed at all.""",
    ),
    (
        "code",
        """def streaks(m):
    r = m.copy()
    key = [r['season'], r['player_id']]
    missed = r['missed'].astype(int)
    block = (missed == 0).astype(int).groupby(key).cumsum()
    run = missed.groupby([r['season'], r['player_id'], block]).cumsum()
    r['k'] = run.groupby(key).shift(1).fillna(0).astype(int)
    reason = np.select([~r['listed'], r['comment'].fillna('').str.contains('Coach', case=False),
                        r['comment'].fillna('').str.contains('Injur|Illness|Concussion|Reconditioning', case=False)],
                       ['not listed', "coach's decision", 'injury or illness'], 'other')
    r['reason'] = np.where(r['missed'] == 1, reason, 'played')
    r['last_reason'] = r.groupby(key)['reason'].shift(1)
    return r[(r['pre_games'] >= 10) & (r['pre_mpg'] >= 15)]


hazards, expected = {}, {}
for lg, m in frames.items():
    s = streaks(m)
    if len(s) < 500:
        continue
    s['k_cap'] = s['k'].clip(upper=10)
    h = s.groupby('k_cap')['missed'].agg(['mean', 'size'])
    hazards[lg] = h
    probs = [h['mean'].get(k, h['mean'].iloc[-1]) for k in range(1, 41)]
    expected[lg] = float(np.sum(np.cumprod(probs)))
    by_reason = s[s['k'] == 1].groupby('last_reason')['missed'].agg(['mean', 'size'])
    print(f"{LABEL[lg]}: expected further games missed after a first miss {expected[lg]:.1f}")
    display(pd.concat({'hazard': h['mean'], 'team-games': h['size']}, axis=1).round(3).T)
    display(by_reason.round(3))
if hazards:
    fig, ax = plt.subplots(figsize=(7, 4))
    for lg, h in hazards.items():
        ax.plot(h.index, h['mean'], marker='o', color=COLOR[lg], label=LABEL[lg])
    ax.set_xlabel('Games missed in a row before (10 = 10 or more)')
    ax.set_ylabel('Chance of missing the next game')
    ax.set_ylim(0, 1)
    ax.legend()
    plt.tight_layout()
    plt.show()""",
    ),
    (
        "md",
        """## What an injury listing meant

Every official injury listing before a regular-season game (the last report by 5 pm Eastern on the
game's date, back to 2023-24 in the NBA and 2026 in the WNBA) with what followed: whether the
player missed that game, and how many of the team's games went by before the player played again
(fct_official_listing). The board charges a listed player the average of those games for the
status, capped at the games the team has left; before this calibration it charged a fixed share
of a game (out: every game left without a return date; doubtful 0.75, questionable 0.5,
day-to-day 0.25).""",
    ),
    (
        "code",
        """OLD = {'Out': 'every game left', 'Doubtful': 0.75, 'Questionable': 0.5, 'Probable': 0.0}
calibration = {}
need = {'league', 'status', 'reason_group', 'played', 'games_missed'}
if need <= columns(con, 'fct_official_listing'):
    ol = con.sql("select league, status, played, games_missed, team_games_left from fct_official_listing "
                 "where reason_group = 'injury'").df()
    for lg in LEAGUES:
        o = ol[ol['league'] == lg]
        if o.empty:
            continue
        t = o.groupby('status').agg(listings=('played', 'size'), missed_game=('played', lambda x: 1 - x.mean()),
                                    games_missed_mean=('games_missed', 'mean'), games_missed_median=('games_missed', 'median'))
        t = t.reindex([x for x in ['Out', 'Doubtful', 'Questionable', 'Probable', 'Available'] if x in t.index])
        t['old_charge'] = t.index.map(OLD)
        calibration[lg] = t
        print(LABEL[lg], f'({len(o):,} injury listings)')
        display(t.round(2))
if not calibration:
    print('No official injury listing in this build lines up with a played game yet.')

ASSUMED = {'out': 1.0, 'doubtful': 0.75, 'questionable': 0.5, 'day_to_day': 0.25}
listing = {}
need = {'league', 'report_date', 'stats_player_id', 'status_group'}
if need <= columns(con, 'fct_availability'):
    av = con.sql("select league, report_date, stats_player_id as player_id, status_group from fct_availability "
                 "where stats_player_id is not null").df()
    av['report_date'] = pd.to_datetime(av['report_date'])
    for lg, m in frames.items():
        a = av[av['league'] == lg]
        if a.empty:
            continue
        nxt = m[['player_id', 'game_date', 'missed']].sort_values('game_date')
        a = a.sort_values('report_date')
        j = pd.merge_asof(a, nxt, left_on='report_date', right_on='game_date', by='player_id', direction='forward')
        j = j[(j['game_date'] - j['report_date']).dt.days <= 3].drop_duplicates(['player_id', 'game_date'], keep='last')
        if len(j):
            t = j.groupby('status_group')['missed'].agg(['mean', 'size'])
            t['board_assumes'] = t.index.map(ASSUMED)
            listing[lg] = t
            print(LABEL[lg])
            display(t.round(3))
if not listing:
    print('No injury listing in this build lines up with a game yet.')""",
    ),
    (
        "code",
        """def eff(lg, outcome, f):
    e = effects_table[(effects_table['league'] == lg) & (effects_table['outcome'] == OUTCOMES[outcome][0])
                      & (effects_table['context'] == {**REST, **TRAVEL}[f])] if len(effects_table) else effects_table
    return e.iloc[0] if len(e) else None


def show(e, digits=2, unit=''):
    return f"{e['estimate']:+.{digits}f}{unit} ({e['lo']:+.{digits}f} to {e['hi']:+.{digits}f})"


for lg in LEAGUES:
    n = int(model_rows(frames[lg], 'missed').shape[0]) if lg in frames else 0
    if lg not in tests or eff(lg, 'fp30_diff', 'b2b') is None:
        findings[lg] = insufficient(
            f"Not enough history in this build: the {LABEL[lg]} context study needs a finished regular season "
            "of player-games, and this build has none yet.", n=n, n_label='player-team-games')
        continue
    test = tests[lg]
    b2b_fp, b2b_miss, b2b_min = eff(lg, 'fp30_diff', 'b2b'), eff(lg, 'missed', 'b2b'), eff(lg, 'minutes_diff', 'b2b')
    defence = eff(lg, 'fp30_diff', 'opp_def_z')
    travel = eff(lg, 'fp30_diff', 'miles_1000')
    h = hazards.get(lg)
    headline = (f"In {test}, the second night of a back-to-back changed a regular's chance of sitting out by "
                f"{b2b_miss['estimate']:+.1f} points and production by {b2b_fp['estimate']:+.2f} fantasy points per 30 minutes"
                + (f", while a standard deviation of opponent defence moved production by {defence['estimate']:+.2f}" if defence is not None else '')
                + (f"; after missing one game, {h['mean'].get(1, np.nan):.0%} missed the next." if h is not None else '.'))
    facts = [
        {'label': 'Back-to-back: chance of sitting out', 'value': show(b2b_miss, 1, ' pts') + (f"; earlier {b2b_miss['earlier_seasons']:+.1f}" if pd.notna(b2b_miss['earlier_seasons']) else '')},
        {'label': 'Back-to-back: minutes and fantasy pts / 30 min', 'value': f"{b2b_min['estimate']:+.2f} min; {show(b2b_fp)}"},
        {'label': 'Opponent defence, per SD: fantasy pts / 30 min', 'value': show(defence) if defence is not None else 'no team ratings in this build'},
        {'label': 'Travel, per 1,000 miles: fantasy pts / 30 min', 'value': show(travel) if travel is not None else 'no travel fields for this season'},
    ]
    if h is not None:
        facts.append({'label': 'Missed the next game after missing 1 / 3 in a row', 'value': f"{h['mean'].get(1, np.nan):.0%} / {h['mean'].get(3, np.nan):.0%}; {expected[lg]:.1f} more games expected after a first miss"})
    if lg in calibration and calibration[lg]['listings'].sum() >= 100:
        t = calibration[lg]
        facts.append({'label': 'Official listings: missed the game; games missed on average',
                      'value': '; '.join(f"{k} {v['missed_game']:.0%}, {v['games_missed_mean']:.1f} (n {int(v['listings']):,})"
                                         for k, v in t.iterrows() if k in ('Out', 'Doubtful', 'Questionable', 'Probable'))})
    elif lg in listing and listing[lg]['size'].sum() >= 30:
        t = listing[lg]
        facts.append({'label': 'Listed players who missed the next game', 'value': '; '.join(f"{k} {v['mean']:.0%} of {int(v['size'])} (board {ASSUMED.get(k, float('nan')):.2f})" for k, v in t.iterrows())})
    elif lg in listing:
        facts.append({'label': 'Injury listings matched to a next game', 'value': f"{int(listing[lg]['size'].sum())} so far: accumulating"})
    elif len(coverage) and lg in coverage.index.get_level_values(0):
        cov = coverage.loc[lg]
        facts.append({'label': 'Travel fields filled, by season', 'value': ', '.join(f"{s} {v:.0%}" for s, v in cov['miles_travelled'].items())})
    e = effects_table[(effects_table['league'] == lg)]
    table = []
    for f, label in {**REST, **TRAVEL}.items():
        cells = []
        for o in ['fp30_diff', 'minutes_diff', 'missed']:
            x = eff(lg, o, f)
            cells.append(None if x is None else show(x, 1 if o == 'missed' else 2))
        if any(cells):
            table.append([label, *cells])
    findings[lg] = {
        'headline': headline,
        'facts': facts[:6],
        'table': {'columns': [f'Context ({test})', 'Fantasy pts / 30 min', 'Minutes', 'Sat out (pts)'], 'rows': table},
        'n': n,
        'n_label': 'player-team-games',
    }
save_findings('03_game_context', {'title': 'Game context', 'leagues': findings})
findings""",
    ),
]
