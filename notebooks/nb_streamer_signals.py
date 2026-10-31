"""02_streamer_signals: which streamer signal finds next week's best pickups?"""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Streamer signals: which one finds next week's best pickups?

**The question.** The Streamers page lists the players a league has most likely left on the wire,
with the window value (last-ten production times the team's games in the window, the default
sort), a minutes trend, a value trend, recent value, games in the next seven days and the
board's value. A manager adding a player on Monday wants the one who produces most over the
coming week. Which of those columns, sorted on, puts that player at the top, and do three
newer signals do better: games the player is expected to play rather than games scheduled,
the board's projected line instead of the last ten games, and a trend in opportunity (minutes
times usage)?

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
  advance), starts in the last five, the old window value (last-ten z-score times games), the
  board's value, and the default sort: last-ten production times games, the per-game
  contribution of the last ten games on the season-to-date scale times the team's games in the
  week.
- **Three newer signals.**
  1. *Expected games.* Each of the team's games in the week is weighted by the chance the
     player plays it. The player's status is the official injury report listing on or before
     the Monday (`fct_official_listing`; NBA from 2023-24, WNBA from 2026), unless the player
     has played since. The chance of missing a game of the week is calibrated, point in time, on
     the listings before that Monday with the same status and reason: the share of their spells
     that lasted that many games, given the games already missed (a Kaplan-Meier curve,
     with a spell still running on the Monday counted only as far as it is known). A league uses
     its own listings once it has 300 for the status, else the NBA's, as the board does. The
     second night of a back-to-back adds the extra chance of sitting out the games before the
     Monday show (the game context notebook measured about 2.3 points in the NBA). Production
     times expected games replaces production times scheduled games.
  2. *The board's projected line.* `replay.project` as of the Monday (season-weighted
     per-minute production times projected minutes), scored on the same contribution scale,
     times games and times expected games.
  3. *Opportunity trend.* Minutes times usage percentage over the last five games against the
     same kind of baseline as the minutes trend.
- **Target**: what the player added to a week's nine category totals over the next seven days.
  Each game's counting stats are taken in units of the category's spread over the season's pool
  (turnovers subtract), and its shooting as makes above the pool's percentage on its attempts,
  in units of that impact's spread: the board's weights, applied to totals rather than averages,
  because a weekly matchup adds up what a roster produces. A game the player did not play adds
  nothing, so games in the week and availability are part of the target.
- **Measures**: the weekly rank correlation of each signal with the target (mean over weeks, and
  a t-statistic of the weekly values), the target by decile of each signal, and the top-10 hit
  rate of each sort (the share of the week's ten best candidates the sort puts in its top ten).
  Two fitted blends are fitted on the earlier seasons, one of the older signals and one with the
  newer ones added; every measure is reported on the latest season, which no fit has seen, and
  on the earlier ones for comparison.""",
    ),
    setup(),
    (
        "code",
        """import replay as rp

SETTINGS = rp.load_settings()
has_usage = 'usage_percentage' in columns(con, 'fct_player_game')
cols = ', '.join([*rp.GAME_COLUMNS, 'usage_percentage' if has_usage else 'null as usage_percentage'])
replays = {}
for lg in LEAGUES:
    g = con.sql(f"select {cols} from fct_player_game where league = '{lg}'").df()
    if len(g):
        g['usage_percentage'] = pd.to_numeric(g['usage_percentage'], errors='coerce')
        r = rp.Replay(g, SETTINGS[lg])
        # opportunity: minutes times the share of the team's plays the player used
        r.games['opportunity'] = (r.games['minutes'] * r.games['usage_percentage']).where(r.games['played'])
        replays[lg] = r

SIGNALS = {
    'week_projection': 'Last-ten production x games (the default sort)',
    'minutes_trend': 'Minutes trend',
    'value_trend': 'Value trend',
    'last_10_z_total': 'Value, last ten games',
    'minutes_avg_5': 'Minutes, last five games',
    'games_next_7': 'Games in the next seven days',
    'starts_last_5': 'Starts in the last five games',
    'window_value': 'Old window value (last-ten z-score x games)',
    'board_value': 'Board value',
    'expected_games': 'Expected games in the next seven days',
    'production_expected': 'Last-ten production x expected games',
    'board_projection': "Board's projected line x games",
    'board_projection_expected': "Board's projected line x expected games",
    'opportunity_trend': 'Opportunity trend (minutes x usage)',
}
NEW = ['expected_games', 'production_expected', 'board_projection', 'board_projection_expected', 'opportunity_trend']
OLD = [k for k in SIGNALS if k not in NEW]
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
    \"\"\"Each player's latest earlier season with games: games, minutes, opportunity and season value.\"\"\"
    g = r.games
    out = []
    for s in [x for x in r.seasons() if x < season]:
        part = g[g['season'] == s]
        z = rp.category_z(rp.lines(part), rp.ZSCORE_POOL[lg])
        opp = part[part['played']].groupby('player_id')['opportunity'].mean()
        out.append(z[['games', 'minutes_pg', 'z_total']].join(opp).assign(season=s))
    if not out:
        return pd.DataFrame(columns=['games', 'minutes_pg', 'z_total', 'opportunity'])
    prev = pd.concat(out).rename_axis('player_id').reset_index().sort_values('season')
    return prev.drop_duplicates('player_id', keep='last').set_index('player_id')""",
    ),
    (
        "md",
        """## Expected games: the official listings, point in time

Each team's regular-season games are numbered in order. A listing's spell is the run of the
team's games, from the listed one, that the player missed (`games_missed`). As of a Monday, the
curve for a status and reason is fitted on the listings before that Monday: a spell that ended
before it counts in full, one still running counts only for the games already played (it is
censored there). The chance a listed player misses the j-th team game after the listing,
having missed the a games since, is S(j) / S(a - 1), where S(j) is the share of spells longer
than j games.""",
    ),
    (
        "code",
        """STATUSES = ('Out', 'Doubtful', 'Questionable', 'Probable')
MAX_SPELL = 100
OLD_CHARGE = {'Out': None, 'Doubtful': 0.75, 'Questionable': 0.5, 'Probable': 0.0}  # the board's charges without history


def team_index(r):
    \"\"\"Every team's regular-season games, numbered within the season, with the second night of a back-to-back.\"\"\"
    g = r.games
    t = g[g['regular']][['season', 'team_id', 'game_id', 'game_date']].drop_duplicates(['season', 'team_id', 'game_id'])
    t = t.sort_values(['season', 'team_id', 'game_date', 'game_id']).reset_index(drop=True)
    t['idx'] = t.groupby(['season', 'team_id']).cumcount()
    t['b2b'] = (t['game_date'] - t.groupby(['season', 'team_id'])['game_date'].shift(1)).dt.days.eq(1)
    return t


if has_table(con, 'fct_official_listing'):
    listings = con.sql(
        \"\"\"select league, season, game_id, game_date, team_id, player_id, status,
               coalesce(reason_group, 'injury') as reason_group, played, games_missed, team_games_left
        from fct_official_listing
        where status in ('Out', 'Doubtful', 'Questionable', 'Probable') and substr(game_id, 3, 1) = '2'\"\"\"
    ).df()
else:
    listings = pd.DataFrame(columns=['league', 'season', 'game_id', 'game_date', 'team_id', 'player_id', 'status',
                                     'reason_group', 'played', 'games_missed', 'team_games_left'])
listings['game_date'] = pd.to_datetime(listings['game_date'])
for c in ['games_missed', 'team_games_left']:
    listings[c] = pd.to_numeric(listings[c]).astype(float)
listings['played'] = listings['played'].astype('boolean').fillna(False).astype(bool)

teams_idx, team_rows, team_games_by_date = {}, {}, {}
for lg, r in replays.items():
    t = team_index(r)
    teams_idx[lg] = t
    team_rows[lg] = t.set_index(['season', 'team_id'])
lst = []
for lg, t in teams_idx.items():
    part = listings[listings['league'] == lg].merge(t[['season', 'team_id', 'game_id', 'idx']], on=['season', 'team_id', 'game_id'])
    lst.append(part)
listings = pd.concat(lst, ignore_index=True) if lst else listings.assign(idx=pd.Series(dtype=int))
# a spell that ended with a played game, rather than the team's season ending first
listings['returned'] = listings['games_missed'] < listings['team_games_left']
if len(listings):
    display(listings.groupby(['league', 'season', 'status']).agg(listings=('player_id', 'size'), missed_game=('played', lambda x: 1 - x.mean()),
                                                                  games_missed=('games_missed', 'mean')).round(2))
else:
    print('No official injury listings in this build: expected games are scheduled games, less the back-to-back uplift.')


def games_before(lg, m):
    \"\"\"Each team-season's regular-season games before the Monday.\"\"\"
    t = teams_idx[lg]
    return t[t['game_date'] < m].groupby(['season', 'team_id']).size()


def survival(part, before):
    \"\"\"Kaplan-Meier share of spells longer than j games, j = 0..MAX_SPELL, from listings before a Monday.\"\"\"
    if part.empty:
        return None
    seen = pd.Series(list(zip(part['season'], part['team_id'], strict=True)), index=part.index).map(before).fillna(0).to_numpy() - part['idx'].to_numpy()
    spell = part['games_missed'].to_numpy()
    event = part['returned'].to_numpy() & (spell < seen)
    last = np.where(event, spell, np.minimum(seen, spell) - 1).astype(int)
    at_risk = np.bincount(np.clip(last + 1, 0, MAX_SPELL + 1), minlength=MAX_SPELL + 2)[::-1].cumsum()[::-1][1:]
    ended = np.bincount(np.clip(spell[event].astype(int), 0, MAX_SPELL), minlength=MAX_SPELL + 1)
    hazard = np.divide(ended, at_risk[: MAX_SPELL + 1], out=np.zeros(MAX_SPELL + 1), where=at_risk[: MAX_SPELL + 1] > 0)
    return np.cumprod(1 - hazard)


def curves(lg, m):
    \"\"\"The survival curve per (status, reason) as of a Monday: the league's own listings once it has 300, else the NBA's.\"\"\"
    out = {}
    past = listings[listings['game_date'] < m]
    befores = {x: games_before(x, m) for x in past['league'].unique() if x in teams_idx}
    for (status, reason), own in past[past['league'] == lg].groupby(['status', 'reason_group']):
        if len(own) >= 300 or lg == 'nba':
            out[(status, reason)] = survival(own, befores[lg])
    nba = past[past['league'] == 'nba']
    if lg != 'nba' and len(nba):
        for (status, reason), part in nba.groupby(['status', 'reason_group']):
            out.setdefault((status, reason), survival(part, befores['nba']))
    return out


def rotation_rows(r):
    \"\"\"Every team game a player was on the team for (first to last box-score listing), missed or not, with the player's minutes so far.\"\"\"
    g = r.games[r.games['regular']]
    t = team_index(r)
    stints = g.groupby(['season', 'player_id', 'team_id'])['game_date'].agg(first='min', last='max').reset_index()
    m = stints.merge(t, on=['season', 'team_id'])
    m = m[(m['game_date'] >= m['first']) & (m['game_date'] <= m['last'])]
    box = g[['season', 'player_id', 'team_id', 'game_id', 'played', 'minutes']]
    m = m.merge(box, on=['season', 'player_id', 'team_id', 'game_id'], how='left')
    m['played'] = m['played'].astype('boolean').fillna(False).astype(bool)
    m = m.sort_values(['season', 'player_id', 'game_date', 'game_id'])
    key = [m['season'], m['player_id']]
    mins = m['minutes'].where(m['played'], 0).fillna(0)
    m['pre_games'] = m['played'].astype(int).groupby(key).cumsum() - m['played'].astype(int)
    m['pre_mpg'] = (mins.groupby(key).cumsum() - mins) / m['pre_games'].replace(0, np.nan)
    m = m[(m['pre_games'] >= 5) & (m['pre_mpg'] >= 10)]
    return m[['game_date', 'b2b', 'played']].assign(missed=lambda d: (~d['played']).astype(float))


rotation = {lg: rotation_rows(r) for lg, r in replays.items()}


def b2b_uplift(lg, m):
    \"\"\"How much more often a rotation player sat out the second night of a back-to-back, in the games before the Monday.\"\"\"
    rows = rotation[lg]
    rows = rows[rows['game_date'] < m]
    rates = rows.groupby('b2b')['missed'].mean()
    if True not in rates.index or False not in rates.index or (rows['b2b']).sum() < 100:
        return 0.0
    return max(0.0, float(rates[True] - rates[False]))


for lg in rotation:
    last = teams_idx[lg]['game_date'].max() + pd.Timedelta(days=1)
    print(f"{LABEL[lg]}: a rotation player sits out the second night of a back-to-back {100 * b2b_uplift(lg, last):.1f} points more often (every season in the build)")


def expected_games(lg, season, m, f):
    \"\"\"Each candidate's expected games in the week starting on the Monday, and the scheduled ones it discounts.\"\"\"
    end = m + pd.Timedelta(days=7)
    t = teams_idx[lg]
    t = t[t['season'] == season]
    window = t[(t['game_date'] >= m) & (t['game_date'] < end)]
    u = b2b_uplift(lg, m)
    rest_factor = 1 - u * window['b2b'].astype(float)
    healthy = rest_factor.groupby(window['team_id']).sum()
    out = f['team_id'].map(healthy).fillna(0.0).astype(float)
    listed_status = pd.Series(np.nan, index=f.index, dtype=object)
    # the player's latest listing on or before the Monday, this season, for the player's current team
    own = listings[(listings['league'] == lg) & (listings['season'] == season) & (listings['game_date'] <= m)]
    own = own[own['player_id'].isin(f.index)].sort_values('game_date').drop_duplicates('player_id', keep='last')
    if own.empty:
        return out, listed_status
    g = replays[lg].games
    played = g[(g['season'] == season) & g['played'] & (g['game_date'] < m)].groupby('player_id')['game_date'].max()
    own = own[own['team_id'].to_numpy() == f.loc[own['player_id'], 'team_id'].to_numpy()]
    # resolved: the player has played since the listing (or played the listed game, before the Monday)
    since = own['player_id'].map(played)
    own = own[~(since.notna() & (since >= own['game_date']))]
    if own.empty:
        return out, listed_status
    cv = curves(lg, m)
    before = games_before(lg, m)
    for _, row in own.iterrows():
        team_window = window[window['team_id'] == row['team_id']]
        if team_window.empty:
            continue
        a = int(before.get((season, row['team_id']), 0) - row['idx'])  # games already missed since the listing
        j = team_window['idx'].to_numpy() - int(row['idx'])
        curve = cv.get((row['status'], row['reason_group']))
        if curve is None:
            charge = OLD_CHARGE[row['status']]
            miss = np.ones(len(j)) if charge is None else np.where(j == j.min(), charge, 0.0)
        else:
            s = np.r_[1.0, curve]  # s[k + 1] = S(k), s[0] = S(-1) = 1
            denom = s[min(max(a, 0), MAX_SPELL + 1)]
            miss = np.ones(len(j)) if denom <= 0 else s[np.clip(j + 1, 0, MAX_SPELL + 1)] / denom
        play = (1 - np.clip(miss, 0, 1)) * (1 - u * team_window['b2b'].astype(float).to_numpy())
        out[row['player_id']] = float(play.sum())
        listed_status[row['player_id']] = row['status']
    return out, listed_status""",
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


def baseline(f, recent, n_recent, season_mean, n_season, prev, weight):
    \"\"\"mart_streamers' baseline: this season's games before the window, blended with last season as up to ten games.\"\"\"
    before = (n_season - n_recent).clip(lower=0)
    mean_before = (season_mean * n_season - recent * n_recent) / before.replace(0, np.nan)
    return ((before * mean_before).fillna(0) + (weight * prev).fillna(0)) / (
        before + weight.where(prev.notna(), 0)).replace(0, np.nan)


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
        minutes_avg_5=('minutes', 'mean'), games_in_window_5=('minutes', 'size'), starts_last_5=('started', 'sum'),
        opportunity_5=('opportunity', 'mean'), opportunity_n_5=('opportunity', 'count'))
    latest = played.groupby('player_id').agg(last_game=('game_date', 'max'), team_id=('team_id', 'last'),
                                             opportunity_season=('opportunity', 'mean'), opportunity_n=('opportunity', 'count'))
    f = season_z[['games', 'minutes_pg', 'z_total']].rename(columns={'z_total': 'season_z_total'})
    f = f.join(last10['z_total'].rename('last_10_z_total')).join(last5).join(latest)
    f = f.join(prev.rename(columns={'games': 'prev_games', 'minutes_pg': 'prev_minutes', 'z_total': 'prev_z',
                                    'opportunity': 'prev_opportunity'}))
    league_last = played['game_date'].max()
    f = f[(f['games'] >= 3) & (f['last_game'] >= league_last - pd.Timedelta(days=30))].copy()
    # baselines, as mart_streamers: the games before the window, blended with last season
    weight = f['prev_games'].fillna(0).clip(upper=PRIOR)
    f['minutes_baseline'] = baseline(f, f['minutes_avg_5'], f['games_in_window_5'], f['minutes_pg'], f['games'], f['prev_minutes'], weight)
    before10 = (f['games'] - f['games'].clip(upper=10)).clip(lower=0)
    f['value_baseline'] = ((before10 * f['season_z_total']).fillna(0) + (weight * f['prev_z']).fillna(0)) / (
        before10 + weight.where(f['prev_z'].notna(), 0)).replace(0, np.nan)
    f['minutes_trend'] = f['minutes_avg_5'] - f['minutes_baseline']
    f['value_trend'] = f['last_10_z_total'] - f['value_baseline']
    f['opportunity_baseline'] = baseline(f, f['opportunity_5'], f['opportunity_n_5'], f['opportunity_season'], f['opportunity_n'],
                                         f['prev_opportunity'], weight)
    f['opportunity_trend'] = f['opportunity_5'] - f['opportunity_baseline']
    # the team's games in the next seven days, and the ones the player is expected to play
    end = monday + pd.Timedelta(days=7)
    upcoming = schedule[(schedule['game_date'] >= monday) & (schedule['game_date'] < end)].groupby('team_id').size()
    f['games_next_7'] = f['team_id'].map(upcoming).fillna(0)
    f['expected_games'], f['listed_status'] = expected_games(lg, season, monday, f)
    f['window_value'] = f['last_10_z_total'] * f['games_next_7']
    scale = value_scale(played, lg)
    recent = played.groupby('player_id').tail(10)
    per_game = contribution(recent, scale).groupby(recent['player_id']).mean().reindex(f.index)
    f['production_10'] = per_game
    f['week_projection'] = per_game * f['games_next_7']
    f['production_expected'] = per_game * f['expected_games']
    # outside the rostered pool on the board as of that Monday
    board = r.board(monday, r.roster_at(season, monday, preseason=False), in_season=True, complete_seasons=earlier)
    f['board_rank'] = board['rank_total'].reindex(f.index) if len(board) else np.nan
    f['board_value'] = board['value_total'].reindex(f.index) if len(board) else np.nan
    if len(board):
        line = board[[f'proj_{c}_pg' for c in (*rp.COUNTING, 'fgm', 'fga', 'ftm', 'fta')]]
        line.columns = [*rp.COUNTING, 'fgm', 'fga', 'ftm', 'fta']
        board_pg = contribution(line, scale).reindex(f.index)
    else:
        board_pg = pd.Series(np.nan, index=f.index)
    f['board_production'] = board_pg
    f['board_projection'] = board_pg * f['games_next_7']
    f['board_projection_expected'] = board_pg * f['expected_games']
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
    display(streams.groupby(['league', 'season']).agg(
        mondays=('monday', 'nunique'), candidates=('player_id', 'size'), mean_target=('target', 'mean'),
        listed=('listed_status', lambda x: x.notna().mean()),
        games_discounted=('games_next_7', 'sum')).assign(
        games_discounted=lambda d: 1 - streams.groupby(['league', 'season'])['expected_games'].sum() / d['games_discounted']).round(3))
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


def paired(part, key, base='week_projection'):
    \"\"\"Weekly top-10 hits of a sort less the default's: mean and t-statistic over the weeks.\"\"\"
    d = np.array([rp.top_hits(w[key].fillna(-np.inf).to_numpy(), w['target'].to_numpy(), 10)
                  - rp.top_hits(w[base].fillna(-np.inf).to_numpy(), w['target'].to_numpy(), 10) for _, w in part.groupby('monday')])
    if len(d) < 2 or d.std(ddof=1) == 0:
        return (float(d.mean()) if len(d) else np.nan), np.nan
    return float(d.mean()), float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def standardise(part, keys):
    z = part[keys].astype(float)
    grouped = z.groupby(part['monday'])
    z = (z - grouped.transform('mean')) / grouped.transform('std').replace(0, np.nan)
    return z.fillna(0)


BLENDS = {'blend_old': ('Fitted blend of the older signals', OLD), 'blend': ('Fitted blend of every signal', list(SIGNALS))}
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
        for name, (_, use) in BLENDS.items():
            X = np.c_[np.ones(len(train)), standardise(train, use).to_numpy()]
            beta = np.linalg.lstsq(X, train['target'].to_numpy(), rcond=None)[0]
            blends[(lg, name)] = dict(zip(['intercept', *use], beta, strict=True))
            held = held.assign(**{name: np.c_[np.ones(len(held)), standardise(held, use).to_numpy()] @ beta})
            train = train.assign(**{name: X @ beta})
    rows = []
    for key in keys + [b for b in BLENDS if b in held]:
        mean_t, t_t, k = weekly(held, key)
        mean_e, t_e, _ = weekly(train, key) if len(train) else (np.nan, np.nan, 0)
        gain, gain_t = paired(held, key)
        rows.append({'signal': SIGNALS.get(key) or BLENDS[key][0], 'key': key,
                     'test_rank_corr': mean_t, 'test_t': t_t, 'earlier_rank_corr': mean_e, 'earlier_t': t_e,
                     'test_top10': top10(held, key), 'earlier_top10': top10(train, key) if len(train) else np.nan,
                     'top10_vs_default': gain, 'top10_vs_default_t': gain_t,
                     'test_top10_value': top10_value(held, key), 'weeks': k})
    tables[lg] = (pd.DataFrame(rows).set_index('key'), held)
    print(f"{LABEL[lg]}: test season {test}, fitted on {', '.join(sorted(train['season'].unique())) or 'nothing'}; "
          f"{held['listed_status'].notna().mean():.1%} of test candidate-weeks had an official listing")
    display(tables[lg][0].round(3))
    for name in BLENDS:
        if (lg, name) in blends:
            print(f'{BLENDS[name][0]} (target per standard deviation of each signal):', {k: round(v, 3) for k, v in blends[(lg, name)].items()})""",
    ),
    (
        "md",
        """## On the candidates the page shows by default

Streamers hides players listed Out unless the Health filter says otherwise, so most of what a
sort could gain by knowing a player is out, the page already has. The same measures again,
over the candidate-weeks whose official listing on the Monday was not Out: does a newer signal
still beat the default once the filter has done its work?""",
    ),
    (
        "code",
        """PAGE_SORTS = ['week_projection', 'production_expected', 'board_projection', 'board_projection_expected', 'opportunity_trend', 'blend']
page_tables = {}
for lg, (table, held) in tables.items():
    shown = held[held['listed_status'] != 'Out']
    earlier = streams[(streams['league'] == lg) & (streams['season'] < tests[lg]) & (streams['listed_status'] != 'Out')]
    rows = []
    for key in [k for k in PAGE_SORTS if k in shown]:
        mean_t, t_t, _ = weekly(shown, key)
        gain, gain_t = paired(shown, key)
        rows.append({'signal': SIGNALS.get(key) or BLENDS[key][0], 'key': key, 'test_top10': top10(shown, key),
                     'top10_vs_default': gain, 'top10_vs_default_t': gain_t, 'test_rank_corr': mean_t, 'test_t': t_t,
                     'earlier_top10': top10(earlier, key) if key in earlier and len(earlier) else np.nan,
                     'earlier_rank_corr': weekly(earlier, key)[0] if key in earlier and len(earlier) else np.nan})
    page_tables[lg] = pd.DataFrame(rows).set_index('key')
    print(f"{LABEL[lg]} {tests[lg]}, players listed Out left out: {len(shown):,} of {len(held):,} candidate-weeks")
    display(page_tables[lg].round(3))""",
    ),
    (
        "md",
        """## The target by decile of each signal

Candidates are cut into deciles of each signal every Monday of the test season. The line is the
average next-seven-day value in each decile, less the week's average candidate: a useful signal
rises from left to right, and a better one rises more steeply at the top.""",
    ),
    (
        "code",
        """def lift(held, key):
    d = held.assign(decile=held.groupby('monday')[key].transform(
        lambda x: pd.qcut(x.rank(method='first'), 10, labels=False) + 1 if x.notna().sum() >= 10 else np.nan))
    d['lift'] = d['target'] - d.groupby('monday')['target'].transform('mean')
    return d.groupby('decile')['lift'].mean()


deciles = {}
if tables:
    panels = [('Older signals', ['week_projection', 'minutes_trend', 'value_trend', 'games_next_7', 'starts_last_5']),
              ('Newer signals against the default', ['week_projection', 'production_expected', 'board_projection_expected', 'expected_games', 'opportunity_trend'])]
    fig, axes = plt.subplots(len(panels), len(tables), figsize=(6 * len(tables), 4 * len(panels)), squeeze=False)
    for col, (lg, (table, held)) in enumerate(tables.items()):
        for row, (title, shown) in enumerate(panels):
            ax = axes[row][col]
            for key in shown:
                line = lift(held, key)
                deciles[(lg, key)] = line
                ax.plot(line.index, line.to_numpy(), marker='o', label=SIGNALS[key])
            ax.axhline(0, color='grey', lw=1)
            ax.set_xlabel('Decile of the signal (10 = highest)')
            ax.set_ylabel('Next-7-day value against the average candidate')
            ax.set_title(f'{LABEL[lg]} {tests[lg]}: {title.lower()}')
            ax.legend(fontsize=8)
    plt.tight_layout()
    plt.show()
    top = pd.DataFrame({f'{LABEL[lg]} {key}': line for (lg, key), line in deciles.items()}).T
    print('Top decile lift (next-7-day value above the average candidate):')
    display(top[[c for c in top.columns if c in (9, 10)]].round(2))""",
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
    test = tests[lg]
    default = table.loc['week_projection']
    singles = table.drop(index=[k for k in BLENDS if k in table.index])
    best_new = singles.loc[NEW, 'test_top10'].idxmax()
    strongest = singles['test_rank_corr'].idxmax()

    def name(key):
        return (SIGNALS.get(key) or BLENDS[key][0]).split(' (')[0].lower()

    new = table.loc[best_new]
    page = page_tables[lg]
    page_default, page_new = page.loc['week_projection'], page.loc[best_new] if best_new in page.index else None
    beats = (new['test_top10'] > default['test_top10']) and (new['test_rank_corr'] > default['test_rank_corr'])
    beats_page = page_new is not None and page_new['top10_vs_default'] > 0 and page_new['test_rank_corr'] > page_default['test_rank_corr']
    headline = (f"On {test} Mondays, the default sort (last-ten production x games) put {default['test_top10'] * 10:.1f} of the "
                f"week's ten best pickups in its top ten. The best of the newer signals, {name(best_new)}, put "
                f"{new['test_top10'] * 10:.1f} ({new['top10_vs_default'] * 10:+.2f}, t = {new['top10_vs_default_t']:.1f})"
                + (", and ranks the week better too" if beats else ", which does not clearly beat it")
                + (f". With players listed Out left out, as the page's Health filter does by default, it put {page_new['test_top10'] * 10:.1f} "
                   f"against the default's {page_default['test_top10'] * 10:.1f}"
                   + (", still ahead." if beats_page else ": the filter already has its gain.") if page_new is not None else "."))
    facts = [
        {'label': f'Weeks and candidates, {test}', 'value': f"{held['monday'].nunique()} Mondays, {len(held):,} candidate-weeks"},
        {'label': 'Default sort, weekly rank correlation', 'value': f"{default['test_rank_corr']:.3f} (t = {default['test_t']:.1f}); earlier seasons {default['earlier_rank_corr']:.3f}"},
        {'label': f'{SIGNALS[best_new]}, weekly rank correlation', 'value': f"{new['test_rank_corr']:.3f} (t = {new['test_t']:.1f})"},
        {'label': 'Candidate-weeks with an official injury listing', 'value': f"{held['listed_status'].notna().mean():.1%}"},
        {'label': 'Strongest single signal by rank correlation', 'value': f"{SIGNALS[strongest].split(' (')[0]}: {table.loc[strongest, 'test_rank_corr']:.3f} (t = {table.loc[strongest, 'test_t']:.1f})"},
        {'label': 'Opportunity trend, rank correlation', 'value': f"{table.loc['opportunity_trend', 'test_rank_corr']:.3f} (t = {table.loc['opportunity_trend', 'test_t']:.1f})"},
        {'label': f'Week value of the top ten: {name(best_new)} vs default', 'value': f"{new['test_top10_value']:.2f} vs {default['test_top10_value']:.2f}"},
    ]
    for b in BLENDS:
        if b in table.index:
            facts.append({'label': f'{BLENDS[b][0]}, top-10 hits', 'value': f"{table.loc[b, 'test_top10'] * 10:.1f} of 10 (fitted on earlier seasons)"})
    for key, r in page.iterrows():
        if key != 'week_projection':
            facts.append({'label': f'Listed Out left out: {name(key)}, top-10 hits and rank correlation',
                          'value': f"{r['test_top10'] * 10:.2f} vs default {page_default['test_top10'] * 10:.2f}; "
                                   f"{r['test_rank_corr']:.3f} vs {page_default['test_rank_corr']:.3f}"})
    findings[lg] = {
        'headline': headline,
        'facts': facts,
        'table': {'columns': ['Sort', f'Top-10 hits, {test}', 'Top-10 hits, earlier', f'Weekly rank corr, {test}', 't'],
                  'rows': [[r['signal'], round(r['test_top10'] * 10, 2),
                            None if pd.isna(r['earlier_top10']) else round(r['earlier_top10'] * 10, 2),
                            round(r['test_rank_corr'], 3), None if pd.isna(r['test_t']) else round(r['test_t'], 1)]
                           for _, r in table.sort_values('test_top10', ascending=False).iterrows()]},
        'n': int(len(held)),
        'n_label': f'candidate-weeks in {test}',
    }
save_findings('02_streamer_signals', {'title': 'Streamer signals', 'leagues': findings})
findings""",
    ),
]
