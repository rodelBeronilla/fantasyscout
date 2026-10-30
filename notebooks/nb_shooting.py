"""05_shooting: which shooting numbers are skill, and how many attempts it takes to tell."""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Shooting: what is sustainable

**The question.** A player who shoots 45% from three over a fortnight looks like a pickup, and a
player in a slump looks like a drop. How much of a shooting percentage is the player and how
much is luck, and after how many attempts can a manager believe it? The same for volume: is a
jump in threes or free throws attempted a role change that lasts?

**Why it matters.** FG% and FT% are two of the nine categories, and three-pointers made is a
third. Chasing a hot percentage on a small sample is the most common way to waste a waiver
claim; ignoring a real change in a player's shot volume is the most common way to miss one.""",
    ),
    (
        "md",
        """## Method

- **Split-half reliability.** Each player-season's games are numbered by date and split into odd
  and even games. The correlation across players of the two halves' percentages, corrected to the
  full sample (Spearman-Brown), is the share of the spread between players that is skill rather
  than noise. Player-seasons need 100 field-goal attempts, 50 three-point attempts or 40 free
  throws over the regular season.
- **Attempts for reliability 0.5.** If reliability after n attempts is n / (n + k), then k is the
  number of attempts at which half the spread is skill; it is solved from the split-half
  correlation at the median attempts per half. It is also shown in games for a player taking the
  median attempts per game.
- **First half against second half.** The slope of the second half of the season on the first
  (split at the season's middle date, both halves with half the minimum attempts) says how much
  of a first-half edge over the league carries into the second half.
- **Over expectation.** With shot charts in the build, every attempt gets an expected make rate
  from its zone, range and distance (in two-foot steps), fitted on the earlier seasons only
  (zone-level when a cell has fewer than 20 attempts), and field goals and threes over that
  expectation are put through the same reliability measures. A season with no earlier shot chart
  is left out of this part.
- **Volume.** Three-point and free-throw attempts per 36 minutes, split the same way, for
  contrast with the percentages.""",
    ),
    setup(),
    (
        "code",
        """import replay as rp

MIN_ATT = {'fg': 100, 'fg3': 50, 'ft': 40}
cols = ', '.join(rp.GAME_COLUMNS)
box = {}
for lg in LEAGUES:
    g = con.sql(f"select {cols} from fct_player_game where league = '{lg}' and substr(game_id, 3, 1) = '2'").df()
    if len(g):
        g = rp.prepare(g)
        g = g[g['played']].sort_values(['season', 'player_id', 'game_date', 'game_id'])
        g['gn'] = g.groupby(['season', 'player_id']).cumcount()
        mid = g.groupby('season')['game_date'].transform(lambda d: d.min() + (d.max() - d.min()) / 2)
        g['first_half'] = (g['game_date'] < mid).astype(int)
        g['fg3m'] = g['three_pointers_made']
        g['fg3a'] = pd.to_numeric(g['three_pointers_attempted'], errors='coerce')
        box[lg] = g


def wide(df, by, cols, values):
    \"\"\"Sums per player-season, one column per half; a player-season missing a half is dropped.\"\"\"
    h = df.groupby(['season', 'player_id', by])[cols].sum().unstack(by)
    return h.reindex(columns=pd.MultiIndex.from_product([cols, values])).dropna()


def halves(df, made, att, by):
    \"\"\"Makes and attempts per player-season in each half of a split.\"\"\"
    h = df.groupby(['season', 'player_id', by])[[made, att]].sum().unstack(by)
    h = h.reindex(columns=pd.MultiIndex.from_product([[made, att], [0, 1]]))  # both halves, even if one is empty
    h.columns = [f'{a}_{int(b)}' for a, b in h.columns]
    return h.dropna()


def reliability(m_a, a_a, m_b, a_b, minimum, e_a=None, e_b=None):
    \"\"\"Split-half reliability of a percentage (or of makes over expectation) across players.\"\"\"
    keep = (a_a + a_b) >= minimum
    a, b = (m_a / a_a)[keep], (m_b / a_b)[keep]
    if e_a is not None:
        a, b = a - (e_a / a_a)[keep], b - (e_b / a_b)[keep]
    ok = np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    if len(a) < 30:
        return None
    r = float(np.corrcoef(a, b)[0, 1])
    half = float(np.median(np.r_[a_a[keep][ok], a_b[keep][ok]]))
    k = half * (1 - r) / r if r > 0 else np.inf
    return {'player_seasons': int(len(a)), 'split_half_r': r, 'reliability': 2 * r / (1 + r) if r > -1 else np.nan,
            'attempts_half': half, 'k': k}


def carry(m_1, a_1, m_2, a_2, minimum, e_1=None, e_2=None):
    \"\"\"Slope of the second half's edge on the first half's, edges against the league.\"\"\"
    keep = (a_1 >= minimum / 2) & (a_2 >= minimum / 2)
    x, y = (m_1 / a_1)[keep], (m_2 / a_2)[keep]
    if e_1 is not None:
        x, y = x - (e_1 / a_1)[keep], y - (e_2 / a_2)[keep]
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 30:
        return None
    x, y = x - x.mean(), y - y.mean()
    return float((x * y).sum() / (x * x).sum())


MEASURES = {'fg': ('FG%', 'field_goals_made', 'field_goals_attempted'), 'fg3': ('3P%', 'fg3m', 'fg3a'),
            'ft': ('FT%', 'free_throws_made', 'free_throws_attempted')}
rows = []
for lg, g in box.items():
    g['odd'] = g['gn'] % 2
    for key, (label, made, att) in MEASURES.items():
        h = halves(g, made, att, 'odd')
        rel = reliability(h[f'{made}_0'], h[f'{att}_0'], h[f'{made}_1'], h[f'{att}_1'], MIN_ATT[key])
        s = halves(g, made, att, 'first_half')
        slope = carry(s[f'{made}_1'], s[f'{att}_1'], s[f'{made}_0'], s[f'{att}_0'], MIN_ATT[key])
        per_season = g.groupby(['season', 'player_id'])[att].agg(['sum', 'mean'])
        if rel:  # games, for a player-season that qualifies (the median one)
            rows.append({'league': lg, 'measure': label, **rel, 'first_to_second_half_slope': slope,
                         'attempts_per_game': float(per_season.loc[per_season['sum'] >= MIN_ATT[key], 'mean'].median())})
box_rel = pd.DataFrame(rows)
if len(box_rel):
    box_rel['games_for_half_skill'] = box_rel['k'] / box_rel['attempts_per_game']
    display(box_rel.round(3))
else:
    print('Too few player-seasons in this build to measure reliability.')""",
    ),
    (
        "code",
        """volume_rows = []
for lg, g in box.items():
    for label, att in [('3PA per 36 min', 'fg3a'), ('FTA per 36 min', 'free_throws_attempted')]:
        h = wide(g.assign(att=g[att]), 'odd', ['att', 'minutes'], [0, 1])
        keep = h[('minutes', 0)].add(h[('minutes', 1)]) >= 500
        a = 36 * h.loc[keep, ('att', 0)] / h.loc[keep, ('minutes', 0)]
        b = 36 * h.loc[keep, ('att', 1)] / h.loc[keep, ('minutes', 1)]
        if len(a) >= 30:
            r = float(np.corrcoef(a, b)[0, 1])
            volume_rows.append({'league': lg, 'measure': label, 'player_seasons': len(a), 'split_half_r': r,
                                'reliability': 2 * r / (1 + r)})
volume = pd.DataFrame(volume_rows)
display(volume.round(3)) if len(volume) else print('Too few player-seasons with 500 minutes.')""",
    ),
    (
        "md",
        """## Over expectation, from the shot charts

An attempt's expected make rate comes from where it was taken, fitted on earlier seasons; a
player's field goals over expectation remove the shot mix (a centre's dunks, a guard's pull-up
threes) and leave the shot-making.""",
    ),
    (
        "code",
        """shot_need = {'league', 'season', 'game_id', 'game_date', 'player_id', 'shot_zone_basic', 'shot_zone_range',
             'shot_distance', 'is_three', 'shot_made'}
have = columns(con, 'fct_shot')
oe_rel, zone_tables = pd.DataFrame(), {}
if shot_need <= have:
    attempted = 'coalesce(shot_attempted, true)' if 'shot_attempted' in have else 'true'
    shots = con.sql(f'''
        with s as (
            select league, season, game_id, game_date, player_id,
                   coalesce(shot_zone_basic, '?') as zb, coalesce(shot_zone_range, '?') as zr,
                   cast(least(greatest(coalesce(shot_distance, 0), 0), 40) / 2 as integer) as d,
                   coalesce(is_three, false) as three, case when shot_made then 1 else 0 end as made
            from fct_shot
            where {attempted} and coalesce(shot_zone_basic, '') <> 'Backcourt' and substr(game_id, 3, 1) = '2'
        ),
        cells as (select league, season, zb, zr, d, count(*) as n, sum(made) as m from s group by all),
        zones as (select league, season, zb, count(*) as n, sum(made) as m from s group by all),
        seasons as (select distinct league, season from s),
        fit as (
            select x.league, x.season, c.zb, c.zr, c.d, sum(c.m) * 1.0 / sum(c.n) as p, sum(c.n) as n
            from seasons as x join cells as c on c.league = x.league and c.season < x.season group by all
        ),
        fitz as (
            select x.league, x.season, z.zb, sum(z.m) * 1.0 / sum(z.n) as p
            from seasons as x join zones as z on z.league = x.league and z.season < x.season group by all
        ),
        numbered as (
            select league, season, player_id, game_id,
                   dense_rank() over (partition by league, season, player_id order by game_date, game_id) as gn
            from (select distinct league, season, player_id, game_id, game_date from s)
        ),
        middle as (
            select league, season, cast(min(game_date) as date) + cast(datediff('day', min(game_date), max(game_date)) // 2 as integer) as mid
            from s group by all
        )
        select s.league, s.season, s.player_id, n.gn % 2 as odd, cast(s.game_date as date) < m.mid as first_half, s.three,
               count(*) as attempts, sum(s.made) as makes,
               sum(case when f.n >= 20 then f.p else fz.p end) as expected
        from s
        join numbered as n using (league, season, player_id, game_id)
        join middle as m using (league, season)
        join fitz as fz on fz.league = s.league and fz.season = s.season and fz.zb = s.zb
        left join fit as f on f.league = s.league and f.season = s.season and f.zb = s.zb and f.zr = s.zr and f.d = s.d
        group by all
    ''').df()
    rows = []
    for lg in LEAGUES:
        part = shots[shots['league'] == lg]
        for label, subset, minimum in [('FG over expectation', part, MIN_ATT['fg']),
                                       ('3P over expectation', part[part['three']], MIN_ATT['fg3'])]:
            if subset.empty:
                continue
            h = wide(subset, 'odd', ['makes', 'attempts', 'expected'], [0, 1])
            rel = reliability(h[('makes', 0)], h[('attempts', 0)], h[('makes', 1)], h[('attempts', 1)], minimum,
                              h[('expected', 0)], h[('expected', 1)])
            s2 = wide(subset, 'first_half', ['makes', 'attempts', 'expected'], [True, False])
            slope = carry(s2[('makes', True)], s2[('attempts', True)], s2[('makes', False)], s2[('attempts', False)], minimum,
                          s2[('expected', True)], s2[('expected', False)]) if len(s2) else None
            if rel:
                rows.append({'league': lg, 'measure': label, **rel, 'first_to_second_half_slope': slope,
                             'seasons': ', '.join(sorted(subset['season'].unique()))})
    oe_rel = pd.DataFrame(rows)
    display(oe_rel.round(3)) if len(oe_rel) else print('Too few shot-chart seasons with an earlier season to fit on.')
    for lg in LEAGUES:
        counts = con.sql(f"select season, count(*) as n from fct_shot where league = '{lg}' group by 1 order by 1 desc").fetchall()
        if not counts:
            continue
        season = counts[1][0] if len(counts) > 1 and counts[0][1] < 0.25 * counts[1][1] else counts[0][0]
        zone_tables[lg] = (season, con.sql(f'''
            select shot_zone_basic as zone, count(*) as attempts,
                   round(100.0 * avg(case when shot_made then 1 else 0 end), 1) as fg_pct,
                   round(100.0 * avg(case when shot_made then (case when is_three then 3 else 2 end) else 0 end), 1) as pp100,
                   round(100.0 * count(*) / sum(count(*)) over (), 1) as share_pct
            from fct_shot
            where league = '{lg}' and season = '{season}' and coalesce(shot_zone_basic, '') not in ('', 'Backcourt')
            group by 1 order by pp100 desc
        ''').df())
else:
    print('This build has no shot charts; the over-expectation part is skipped.')""",
    ),
    (
        "code",
        """curves = pd.concat([box_rel.assign(source='box'), oe_rel.assign(source='chart')], ignore_index=True) if len(box_rel) or len(oe_rel) else pd.DataFrame()
if len(curves):
    fig, axes = plt.subplots(1, len(box), figsize=(6 * len(box), 4), squeeze=False)
    n = np.arange(0, 1001)
    for ax, lg in zip(axes[0], box, strict=False):
        for _, r in curves[curves['league'] == lg].iterrows():
            if np.isfinite(r['k']):
                ax.plot(n, n / (n + r['k']), label=f"{r['measure']} (k = {r['k']:.0f})")
        ax.axhline(0.5, color='grey', lw=1, ls='--')
        ax.set_xlabel('Attempts')
        ax.set_ylabel('Share of the spread that is skill')
        ax.set_ylim(0, 1)
        ax.set_title(f'{LABEL[lg]}: how fast shooting numbers settle')
        ax.legend(fontsize=8)
    plt.tight_layout()
    plt.show()
if zone_tables:
    fig, axes = plt.subplots(1, len(zone_tables), figsize=(6 * len(zone_tables), 4), squeeze=False)
    for ax, (lg, (season, z)) in zip(axes[0], zone_tables.items(), strict=False):
        ax.barh(z['zone'], z['pp100'], color=COLOR[lg])
        ax.invert_yaxis()
        ax.set_xlabel('Points per 100 attempts')
        ax.set_title(f'{LABEL[lg]} {season}: what a shot is worth by zone')
    plt.tight_layout()
    plt.show()
    for lg, (season, z) in zone_tables.items():
        print(LABEL[lg], season)
        display(z)""",
    ),
    (
        "code",
        """def measure(lg, name):
    t = curves[(curves['league'] == lg) & (curves['measure'] == name)] if len(curves) else curves
    return t.iloc[0] if len(t) else None


for lg in LEAGUES:
    part = curves[curves['league'] == lg] if len(curves) else curves
    fg = measure(lg, 'FG%')
    if fg is None:
        n = int(len(box[lg])) if lg in box else 0
        findings[lg] = insufficient(
            f"Not enough history in this build: the {LABEL[lg]} shooting study needs 30 or more player-seasons "
            "with 100 field-goal attempts, and this build has fewer.", n=n, n_label='player-games')
        continue
    ft, fg3 = measure(lg, 'FT%'), measure(lg, '3P%')
    oe = measure(lg, 'FG over expectation')
    def k(r):
        return 'never' if r is None or not np.isfinite(r['k']) else f"{r['k']:,.0f}"
    headline = (f"Half of the spread in {LABEL[lg]} free-throw percentage is skill after about {k(ft)} attempts, "
                f"against {k(fg3)} three-point attempts and {k(fg)} field-goal attempts"
                + (f"; a first-half three-point edge keeps {fg3['first_to_second_half_slope']:.0%} of itself after the break."
                   if fg3 is not None and fg3['first_to_second_half_slope'] is not None and pd.notna(fg3['first_to_second_half_slope']) else '.'))
    facts = []
    for r in [ft, fg3, fg]:
        if r is not None:
            facts.append({'label': f"{r['measure']}: attempts for half skill", 'value': f"{k(r)} (about {r['k'] / r['attempts_per_game']:.0f} games at {r['attempts_per_game']:.1f} a game)" if np.isfinite(r['k']) else 'never'})
    if oe is not None:
        facts.append({'label': 'FG over expectation: attempts for half skill', 'value': k(oe)})
    vol = volume[(volume['league'] == lg) & (volume['measure'] == '3PA per 36 min')] if len(volume) else volume
    if len(vol):
        facts.append({'label': 'Three-point volume (3PA per 36), split-half reliability', 'value': f"{vol.iloc[0]['reliability']:.2f}, against {fg3['reliability']:.2f} for 3P%" if fg3 is not None else f"{vol.iloc[0]['reliability']:.2f}"})
    if lg in zone_tables:
        season, z = zone_tables[lg]
        facts.append({'label': f'Most valuable zone, {season}', 'value': f"{z.iloc[0]['zone']}: {z.iloc[0]['pp100']:.0f} pts / 100"})
    table = [[r['measure'], k(r), round(r['reliability'], 2),
              None if r.get('first_to_second_half_slope') is None or pd.isna(r.get('first_to_second_half_slope')) else round(r['first_to_second_half_slope'], 2),
              int(r['player_seasons'])] for _, r in part.iterrows()]
    findings[lg] = {
        'headline': headline,
        'facts': facts[:6],
        'table': {'columns': ['Measure', 'Attempts for half skill', 'Split-half reliability', 'First-to-second-half slope', 'Player-seasons'],
                  'rows': table},
        'n': int(fg['player_seasons']),
        'n_label': 'player-seasons with 100 field-goal attempts',
    }
save_findings('05_shooting', {'title': 'Shooting: what is sustainable', 'leagues': findings})
findings""",
    ),
]
