"""06_prop_lines: how far the board's projections sit from the sportsbooks' player lines."""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Prop lines: the board against the sportsbooks

**The question.** A sportsbook's line on a player's points, rebounds or assists is a projection
with money behind it. How far from those lines do the board's projections sit, in which
categories, and once games have been played, which of the two was closer to what happened?

**Why it matters.** The board projects a player from the season so far and the seasons before.
The books also know tonight's matchup, the minutes the coaches have hinted at and the late
injury news. Where the two disagree systematically, the board is missing something it could
learn; where the board is as close to the outcomes as the line, it needs no help.

**Privacy.** Prop lines are a private model input (ADR 0008). This notebook prints and saves
aggregates only (mean gaps, mean absolute errors, coverage), never a player's line, and it
makes no picks. Sources: DraftKings through ESPN, and The Odds API when its key is configured.""",
    ),
    (
        "md",
        """## Method

- **Lines.** `fct_player_prop` keeps the last line each bookmaker set before tip-off; the
  consensus is the mean across bookmakers, one row per player, game and market. The markets
  compared are points, rebounds, assists, threes, steals, blocks and turnovers, and the
  combinations (points plus rebounds and so on) as sums of the board's figures.
- **The board's figure** is the per-game projection the board showed before the game: the
  latest `fct_board_history` snapshot on or before the game's date or, for a game the ledger
  has no snapshot for yet, today's `mart_board` when the game is today or later.
- **Against the line**: the mean absolute gap between the two and the mean signed gap (board
  minus line: positive when the board expects more), per market.
- **Against the outcome**, for games played since the lines landed (`fct_player_game`, players
  who played): the mean absolute error of the line and of the board, and how well the
  consensus over probability (vig removed) was calibrated (Brier score, and the share of overs
  that came in against the mean probability). Pushes, a result exactly on the line, are left
  out of the calibration.
- **Enough history.** Prop lines have landed for days, not seasons. The outcome comparison
  needs 200 player-game-markets over 7 game dates, and says so until then.""",
    ),
    setup(),
    (
        "code",
        """MIN_OUTCOMES, MIN_DATES = 200, 7
MARKETS = {
    'points': ['points'], 'rebounds': ['rebounds_total'], 'assists': ['assists'],
    'threes': ['three_pointers_made'], 'steals': ['steals'], 'blocks': ['blocks'], 'turnovers': ['turnovers'],
    'points_rebounds': ['points', 'rebounds_total'], 'points_assists': ['points', 'assists'],
    'rebounds_assists': ['rebounds_total', 'assists'], 'points_rebounds_assists': ['points', 'rebounds_total', 'assists'],
    'steals_blocks': ['steals', 'blocks'],
}
STATS = ['points', 'rebounds_total', 'assists', 'three_pointers_made', 'steals', 'blocks', 'turnovers']
PROJ = ', '.join(f'proj_{s}_pg' for s in STATS)

have_props = has_table(con, 'fct_player_prop')
lines = con.sql('''
    select league, game_id, cast(game_date as date) as game_date, player_id, market,
           any_value(consensus_line) as line, any_value(consensus_over_prob_no_vig) as p_over,
           any_value(books_quoting) as books
    from fct_player_prop group by all
''').df() if have_props else pd.DataFrame(columns=['league', 'game_id', 'game_date', 'player_id', 'market', 'line', 'p_over', 'books'])
lines = lines[lines['market'].isin(MARKETS)]

board_cols = columns(con, 'fct_board_history')
if len(lines) and {f'proj_{s}_pg' for s in STATS} <= board_cols:
    con.register('prop_lines', lines)
    history = con.sql(f'''
        select l.league, l.game_id, l.player_id, l.market, h.snapshot_date, {', '.join(f'h.proj_{s}_pg' for s in STATS)}
        from prop_lines as l
        asof join fct_board_history as h
            on h.league = l.league and h.player_id = l.player_id and l.game_date >= h.snapshot_date
    ''').df()
else:
    history = pd.DataFrame(columns=['league', 'game_id', 'player_id', 'market', 'snapshot_date'] + [f'proj_{s}_pg' for s in STATS])
today = con.sql(f'select league, player_id, in_pool, {PROJ} from mart_board').df()

compared = lines.merge(history, on=['league', 'game_id', 'player_id', 'market'], how='left')
upcoming = compared['snapshot_date'].isna() & (pd.to_datetime(compared['game_date']) >= pd.Timestamp.today().normalize())
fallback = compared[upcoming][['league', 'player_id']].merge(today, on=['league', 'player_id'], how='left')
for s in STATS:
    col = f'proj_{s}_pg'
    compared.loc[upcoming, col] = fallback[col].to_numpy()
compared['board'] = np.nan
for market, parts in MARKETS.items():
    rows = compared['market'] == market
    compared.loc[rows, 'board'] = sum(pd.to_numeric(compared.loc[rows, f'proj_{p}_pg'], errors='coerce') for p in parts)
compared = compared[compared['board'].notna()]
compared['gap'] = compared['board'] - compared['line']
print(f"{len(lines):,} player-game-market lines in this build; {len(compared):,} with a board projection to compare.")""",
    ),
    (
        "code",
        """def board_vs_line(df):
    if df.empty:
        return pd.DataFrame(columns=['league', 'market', 'n', 'mae_board_vs_line', 'mean_gap', 'board_above_line'])
    return (df.groupby(['league', 'market'])
              .agg(n=('gap', 'size'), mae_board_vs_line=('gap', lambda g: g.abs().mean()),
                   mean_gap=('gap', 'mean'), board_above_line=('gap', lambda g: (g > 0).mean()))
              .reset_index())


vs_line = board_vs_line(compared)
display(vs_line.round(3)) if len(vs_line) else print('No prop lines to compare with the board in this build yet.')""",
    ),
    (
        "md",
        """## Against the outcome

Only once the games have been played, and only with enough of them.""",
    ),
    (
        "code",
        """box_cols = ', '.join(STATS)
played = con.sql(f'''
    select league, game_id, player_id, {box_cols}
    from fct_player_game where played
''').df()
outcomes = compared.merge(played, on=['league', 'game_id', 'player_id'], how='inner')
if len(outcomes):
    outcomes['actual'] = 0.0
    for market, parts in MARKETS.items():
        rows = outcomes['market'] == market
        outcomes.loc[rows, 'actual'] = sum(pd.to_numeric(outcomes.loc[rows, p], errors='coerce') for p in parts)
    outcomes['err_line'] = (outcomes['actual'] - outcomes['line']).abs()
    outcomes['err_board'] = (outcomes['actual'] - outcomes['board']).abs()
    decided = outcomes[outcomes['actual'] != outcomes['line']].dropna(subset=['p_over'])
    decided = decided.assign(over=(decided['actual'] > decided['line']).astype(float))
else:
    decided = pd.DataFrame(columns=['league', 'market', 'over', 'p_over'])


def enough(lg):
    part = outcomes[outcomes['league'] == lg] if len(outcomes) else outcomes
    return len(part) >= MIN_OUTCOMES and part['game_date'].nunique() >= MIN_DATES, len(part)


rows = []
for lg in LEAGUES:
    ok, n = enough(lg)
    if not ok:
        print(f"{LABEL[lg]}: {n} player-game-markets with an outcome; the comparison waits for {MIN_OUTCOMES} over {MIN_DATES} game dates.")
        continue
    part = outcomes[outcomes['league'] == lg]
    cal = decided[decided['league'] == lg]
    for market, g in part.groupby('market'):
        c = cal[cal['market'] == market]
        rows.append({'league': lg, 'market': market, 'n': len(g), 'mae_line': g['err_line'].mean(),
                     'mae_board': g['err_board'].mean(),
                     'brier': ((c['over'] - c['p_over']) ** 2).mean() if len(c) else np.nan,
                     'over_rate': c['over'].mean() if len(c) else np.nan,
                     'mean_p_over': c['p_over'].mean() if len(c) else np.nan})
vs_outcome = pd.DataFrame(rows)
if len(vs_outcome):
    display(vs_outcome.round(3))""",
    ),
    (
        "code",
        """if len(vs_line):
    fig, axes = plt.subplots(1, vs_line['league'].nunique(), figsize=(6 * vs_line['league'].nunique(), 4), squeeze=False)
    for ax, (lg, part) in zip(axes[0], vs_line.groupby('league', sort=False), strict=False):
        part = part.sort_values('mean_gap')
        ax.barh(part['market'], part['mean_gap'], color=COLOR[lg])
        ax.axvline(0, color='grey', lw=1)
        ax.set_xlabel('Board minus line, mean per player-game')
        ax.set_title(f'{LABEL[lg]}: where the board expects more than the books')
    plt.tight_layout()
    plt.show()""",
    ),
    (
        "code",
        """in_pool = today[today['in_pool'].fillna(False).astype(bool)]
for lg in LEAGUES:
    part = vs_line[vs_line['league'] == lg] if len(vs_line) else vs_line
    raw = lines[lines['league'] == lg]
    if part.empty:
        findings[lg] = insufficient(
            f"No {LABEL[lg]} prop lines in this build yet: they land from the morning and evening runs before each game day.",
            n=len(raw), n_label='player-game-market lines')
        continue
    mine = compared[compared['league'] == lg]
    pool = in_pool[in_pool['league'] == lg]
    covered = pool['player_id'].isin(raw['player_id']).mean() if len(pool) else np.nan
    total = int(part['n'].sum())
    mae = float((mine['gap'].abs()).mean())
    pts = part[part['market'] == 'points']
    headline = (f"Across {total:,} {LABEL[lg]} player-game lines, the board's projection sits {mae:.2f} from the books' line on average"
                + (f"; on points it is {pts.iloc[0]['mean_gap']:+.2f} a game from the line." if len(pts) else '.'))
    facts = [
        {'label': 'Games with lines', 'value': f"{raw['game_id'].nunique():,} games on {raw['game_date'].nunique():,} dates"},
        {'label': 'Players with a line', 'value': f"{raw['player_id'].nunique():,}"},
        {'label': "Share of the board's rostered pool with a line", 'value': f'{covered:.0%}' if pd.notna(covered) else 'n/a'},
        {'label': 'Bookmakers per line, mean', 'value': f"{raw['books'].mean():.1f}"},
    ]
    ok, n_out = enough(lg)
    out = vs_outcome[vs_outcome['league'] == lg] if len(vs_outcome) else vs_outcome
    if ok and len(out):
        weights = out['n'] / out['n'].sum()
        facts.append({'label': 'Error against the outcome, line vs board', 'value': f"{(out['mae_line'] * weights).sum():.2f} vs {(out['mae_board'] * weights).sum():.2f}"})
    else:
        facts.append({'label': 'Against the outcome', 'value': f'accumulating: {n_out} of {MIN_OUTCOMES} player-game-markets'})
    table_rows = []
    for _, r in part.sort_values('n', ascending=False).iterrows():
        o = out[out['market'] == r['market']] if len(out) else out
        table_rows.append([r['market'], int(r['n']), round(r['mae_board_vs_line'], 2), round(r['mean_gap'], 2),
                           round(o.iloc[0]['mae_line'], 2) if len(o) else None, round(o.iloc[0]['mae_board'], 2) if len(o) else None])
    findings[lg] = {
        'headline': headline,
        'facts': facts[:6],
        'table': {'columns': ['Market', 'Player-games', 'Board vs line, mean absolute gap', 'Board minus line, mean',
                              'Line error vs outcome', 'Board error vs outcome'], 'rows': table_rows},
        'n': total,
        'n_label': 'player-game-market lines compared',
    }
save_findings('06_prop_lines', {'title': 'Prop lines: the board against the sportsbooks', 'leagues': findings})
findings""",
    ),
]
