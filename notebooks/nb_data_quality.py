"""04_data_quality: a scorecard of the checks that matter, per league and season."""

from nb_common import setup

CELLS = [
    (
        "md",
        """# Data quality scorecard

**The question.** Can the numbers in this build be trusted, league by league and season by
season? The site's Data Health page shows the latest run's checks; this notebook measures the
data itself: whether the two box-score sources agree, whether player rows add up to the team
rows, whether the shot charts match the box scores, how complete the lineups are, how many
injury, waiver and status rows link to a player, how fresh each source is, and how the dbt checks
have trended.

**Why it matters.** Every ranking on the site sums these rows. A season whose shot chart drops a
tenth of the attempts, or an injury feed that links four players in five, moves values without
anyone noticing. Each check has a value, a threshold and a status, so a regression shows up as a
change of status rather than as a number to interpret.""",
    ),
    (
        "md",
        """## Method

Each check reads only the columns it needs (`fct_event` is large, so it reads three). A table the
build does not carry, or a season the source does not cover, is `n/a`, not a failure.

| Check | Pass | Warn |
| --- | --- | --- |
| Played player-games matched across sources | 99% or more | 95% or more |
| Conflicts among matched player-games | 0.5% or less | 2% or less |
| Team-games whose player rows add up to the team row (every counting stat but turnovers) | all | 99.5% or more |
| Team turnovers at least the players' and at most eight more | 99% or more | 95% or more |
| Team-games with a shot chart, for seasons with any | 98% or more | 90% or more |
| Shot chart attempts, makes and threes equal to the box score | 99% or more | 95% or more |
| Play-by-play actions with five a side on the floor | 90% or more (ADR 0003) | below 90% |
| Current injury listings, trending waiver players and statuses linked to a player | 95% / 95% / 98% or more | 90% / 90% / 95% or more |
| Hours since a source last finished | 36 or fewer | a week or fewer |
| Ingest failures in the last seven days | none | any |
| Latest dbt run: checks failing or erroring / warning | none / none | none failing |""",
    ),
    setup(),
    (
        "code",
        """checks = []


def grade(value, good, ok, higher=True):
    if value is None or pd.isna(value):
        return 'n/a'
    if higher:
        return 'pass' if value >= good else 'warn' if value >= ok else 'fail'
    return 'pass' if value <= good else 'warn' if value <= ok else 'fail'


def add(check, league, season, value, threshold, status, detail=''):
    checks.append({'check': check, 'league': league, 'season': season, 'value': value, 'threshold': threshold,
                   'status': status, 'detail': detail})


def pct(x, digits=1):
    return None if x is None or pd.isna(x) else f'{100 * x:.{digits}f}%'


def run(name, fn):
    \"\"\"Run one check; a failure to compute it is reported, not raised.\"\"\"
    try:
        fn()
    except Exception as exc:  # a build whose table has another shape
        add(name, 'all', '', None, '', 'n/a', f'could not compute: {type(exc).__name__}: {str(exc)[:120]}')""",
    ),
    (
        "md",
        """## Source agreement

Every player-game both sources report is compared on thirteen values (ADR 0005). Coverage is the
share of played player-games the second source matched; the conflict rate is the share of those
that disagree on a counting stat. The second table lists which values differ when they do.""",
    ),
    (
        "code",
        """summary = pd.DataFrame()


def source_agreement():
    global summary
    if not has_table(con, 'reconciliation_summary'):
        add('Source agreement', 'all', '', None, '', 'n/a', 'no reconciliation_summary in this build')
        return
    summary = con.sql('''
        select league, season, played_player_games, played_matched, played_match_rate, conflict, conflict_rate
        from reconciliation_summary order by league, season
    ''').df()
    for _, r in summary.iterrows():
        add('Played player-games matched across sources', r['league'], r['season'], pct(r['played_match_rate']), '99% / 95%',
            grade(r['played_match_rate'], 0.99, 0.95), f"{int(r['played_matched'] or 0):,} of {int(r['played_player_games'] or 0):,}")
        add('Conflicts among matched player-games', r['league'], r['season'], pct(r['conflict_rate'], 2), '0.5% / 2%',
            grade(r['conflict_rate'], 0.005, 0.02, higher=False), f"{int(r['conflict'] or 0):,} in conflict")


run('Source agreement', source_agreement)
if len(summary):
    fig, axes = plt.subplots(1, 2, figsize=(11, 4))
    for lg in LEAGUES:
        part = summary[summary['league'] == lg]
        if part.empty:
            continue
        axes[0].plot(part['season'], 100 * part['played_match_rate'], marker='o', label=LABEL[lg], color=COLOR[lg])
        axes[1].plot(part['season'], 100 * part['conflict_rate'].fillna(0), marker='o', label=LABEL[lg], color=COLOR[lg])
    axes[0].axhline(99, ls='--', color='grey', lw=1)
    axes[0].set_title('Played player-games matched (%)')
    axes[1].set_title('Conflict rate among matched (%)')
    for ax in axes:
        ax.tick_params(axis='x', rotation=45)
        ax.legend()
    plt.tight_layout()
    plt.show()
if has_table(con, 'reconciliation'):
    by_stat = con.sql('''
        select league, stat, count(*) as differences, round(avg(abs(delta)), 2) as mean_abs_delta,
               sum(case when resolution = 'espn' then 1 else 0 end) as filled_from_second_source
        from reconciliation group by 1, 2 order by 1, 3 desc
    ''').df()
    display(by_stat)""",
    ),
    (
        "md",
        """## Box scores, shot charts and lineups""",
    ),
    (
        "code",
        """def box_closure():
    need = {'points', 'rebounds_total', 'assists', 'steals', 'blocks', 'turnovers', 'field_goals_made'}
    if not need <= columns(con, 'fct_team_game'):
        add('Team-games whose player rows add up', 'all', '', None, '', 'n/a', 'no fct_team_game in this build')
        return
    stats = ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'field_goals_made', 'field_goals_attempted',
             'three_pointers_made', 'three_pointers_attempted', 'free_throws_made', 'free_throws_attempted']
    sums = ', '.join(f'coalesce(sum({s}), 0) as {s}' for s in [*stats, 'turnovers'])
    closes = ' and '.join(f'p.{s} = coalesce(t.{s}, 0)' for s in stats)
    df = con.sql(f'''
        with p as (select league, season, game_id, team_id, {sums} from fct_player_game group by all)
        select t.league, t.season, count(*) as team_games,
               avg(case when {closes} then 1.0 else 0.0 end) as closes,
               avg(case when t.turnovers - p.turnovers between 0 and 8 then 1.0 else 0.0 end) as turnovers_ok
        from fct_team_game as t join p using (league, season, game_id, team_id)
        group by all order by 1, 2
    ''').df()
    for _, r in df.iterrows():
        add('Team-games whose player rows add up', r['league'], r['season'], pct(r['closes'], 2), 'all / 99.5%',
            grade(r['closes'], 1.0, 0.995), f"{int(r['team_games']):,} team-games")
        add('Team turnovers between the players\\' sum and eight more', r['league'], r['season'], pct(r['turnovers_ok']), '99% / 95%',
            grade(r['turnovers_ok'], 0.99, 0.95))


def shots_vs_box():
    need = {'league', 'season', 'game_id', 'team_id', 'shot_made', 'is_three'}
    have = columns(con, 'fct_shot')
    if not need <= have:
        add('Team-games with a shot chart', 'all', '', None, '', 'n/a', 'no fct_shot in this build')
        return
    attempted = 'coalesce(shot_attempted, true)' if 'shot_attempted' in have else 'true'
    df = con.sql(f'''
        with s as (
            select league, season, game_id, team_id, count(*) as fga,
                   sum(case when shot_made then 1 else 0 end) as fgm, sum(case when is_three then 1 else 0 end) as fg3a
            from fct_shot where {attempted} group by all
        ),
        b as (
            select league, season, game_id, team_id, sum(field_goals_attempted) as fga, sum(field_goals_made) as fgm,
                   sum(three_pointers_attempted) as fg3a
            from fct_player_game group by all
        )
        select b.league, b.season, count(*) as team_games, count(s.game_id) as with_shots,
               avg(case when s.game_id is null then null when s.fga = b.fga then 1.0 else 0.0 end) as fga_match,
               avg(case when s.game_id is null then null when s.fgm = b.fgm then 1.0 else 0.0 end) as fgm_match,
               avg(case when s.game_id is null then null when s.fg3a = b.fg3a then 1.0 else 0.0 end) as fg3a_match,
               sum(s.fga) as chart_attempts, sum(case when s.game_id is not null then b.fga end) as box_attempts
        from b left join s using (league, season, game_id, team_id)
        group by all order by 1, 2
    ''').df()
    for _, r in df.iterrows():
        cover = r['with_shots'] / r['team_games'] if r['team_games'] else None
        if not r['with_shots']:
            add('Team-games with a shot chart', r['league'], r['season'], '0%', '98% / 90%', 'n/a', 'no shot chart landed for this season')
            continue
        add('Team-games with a shot chart', r['league'], r['season'], pct(cover), '98% / 90%', grade(cover, 0.98, 0.90),
            f"{int(r['with_shots']):,} of {int(r['team_games']):,}")
        for col, label in [('fga_match', 'attempts'), ('fgm_match', 'makes'), ('fg3a_match', 'three-point attempts')]:
            add(f'Shot chart {label} equal to the box score', r['league'], r['season'], pct(r[col]), '99% / 95%',
                grade(r[col], 0.99, 0.95), f"chart {int(r['chart_attempts'] or 0):,} vs box {int(r['box_attempts'] or 0):,} attempts" if col == 'fga_match' else '')


def lineups():
    if 'lineup_complete' not in columns(con, 'fct_event'):
        add('Actions with five a side on the floor', 'all', '', None, '', 'n/a', 'no lineups in fct_event in this build')
        return
    df = con.sql('''
        select league, season, count(*) as actions, avg(case when lineup_complete then 1.0 else 0.0 end) as complete
        from fct_event group by all order by 1, 2
    ''').df()
    for _, r in df.iterrows():
        add('Actions with five a side on the floor', r['league'], r['season'], pct(r['complete']), '90%',
            'pass' if r['complete'] >= 0.9 else 'warn', f"{int(r['actions']):,} actions")


for name, fn in [('Box closure', box_closure), ('Shots vs box', shots_vs_box), ('Lineups', lineups)]:
    run(name, fn)
pd.DataFrame(checks).query("check not in ['Played player-games matched across sources', 'Conflicts among matched player-games']")""",
    ),
    (
        "md",
        """## Links, freshness and the dbt checks""",
    ),
    (
        "code",
        """def links():
    have = columns(con, 'fct_availability')
    if {'league', 'stats_player_id', 'is_current'} <= have:
        df = con.sql('''
            select league, count(*) filter (where is_current) as current,
                   avg(case when stats_player_id is not null then 1.0 else 0.0 end) filter (where is_current) as linked,
                   avg(case when stats_player_id is not null then 1.0 else 0.0 end) as linked_all
            from fct_availability group by 1
        ''').df()
        for _, r in df.iterrows():
            add('Current injury listings linked to a player', r['league'], 'current', pct(r['linked']), '95% / 90%',
                grade(r['linked'], 0.95, 0.90), f"{int(r['current'] or 0)} listings; {pct(r['linked_all'])} of all")
    else:
        add('Current injury listings linked to a player', 'all', 'current', None, '', 'n/a', 'no fct_availability in this build')
    if {'league', 'stats_player_id'} <= columns(con, 'fct_waiver_trend'):
        df = con.sql('''
            select league, count(*) as players, avg(case when stats_player_id is not null then 1.0 else 0.0 end) as linked
            from fct_waiver_trend group by 1
        ''').df()
        for lg in LEAGUES:
            r = df[df['league'] == lg]
            if r.empty or not r.iloc[0]['players']:
                add('Trending waiver players linked to a player', lg, 'current', None, '95% / 90%', 'n/a', 'no waiver trend rows')
                continue
            r = r.iloc[0]
            add('Trending waiver players linked to a player', lg, 'current', pct(r['linked']), '95% / 90%',
                grade(r['linked'], 0.95, 0.90), f"{int(r['players'])} trending players")
    if {'league', 'stats_player_id'} <= columns(con, 'fct_player_status') and has_table(con, 'dim_player'):
        df = con.sql('''
            select s.league, count(*) as players,
                   avg(case when p.stats_player_id is not null then 1.0 else 0.0 end) as known
            from fct_player_status as s
            left join (select distinct league, stats_player_id from dim_player where is_current) as p
                on p.league = s.league and p.stats_player_id = s.stats_player_id
            group by 1
        ''').df()
        for _, r in df.iterrows():
            add('Player statuses on a current player', r['league'], 'current', pct(r['known']), '98% / 95%',
                grade(r['known'], 0.98, 0.95), f"{int(r['players'])} statuses")


def freshness():
    need = {'source', 'league', 'finished_at', 'started_at', 'failures'}
    if not need <= columns(con, 'ingest_log'):
        add('Hours since the source last finished', 'all', 'current', None, '', 'n/a', 'no ingest_log in this build')
        return
    df = con.sql('''
        select coalesce(league, 'all') as league, source, max(finished_at) as last_finished,
               sum(case when started_at >= now()::timestamp - interval 7 day then coalesce(failures, 0) else 0 end) as failures_7d,
               count(*) filter (where started_at >= now()::timestamp - interval 7 day) as runs_7d
        from ingest_log group by 1, 2 order by 1, 2
    ''').df()
    now = pd.Timestamp.now(tz='UTC').tz_localize(None)
    for _, r in df.iterrows():
        age = (now - pd.Timestamp(r['last_finished']).tz_localize(None)).total_seconds() / 3600 if pd.notna(r['last_finished']) else None
        add(f"Hours since {r['source']} last finished", r['league'], 'current', None if age is None else round(age, 1),
            '36 / 168', grade(age, 36, 168, higher=False))
        add(f"Ingest failures, {r['source']}, last 7 days", r['league'], 'current', int(r['failures_7d']), '0',
            'pass' if r['failures_7d'] == 0 else 'warn', f"{int(r['runs_7d'])} runs")


history = pd.DataFrame()


def dbt_checks():
    global history
    if not {'run_id', 'run_at', 'resource_type', 'status'} <= columns(con, 'test_results'):
        add('Latest dbt run: checks failing or erroring', 'all', 'current', None, '', 'n/a', 'no test_results in this build')
        return
    history = con.sql('''
        select run_id, max(run_at) as run_at,
               sum(case when status = 'warn' then 1 else 0 end) as warn,
               sum(case when status in ('fail', 'error') then 1 else 0 end) as fail,
               count(*) as checks
        from test_results where resource_type = 'test' group by 1 order by 2 desc limit 60
    ''').df()
    if history.empty:
        add('Latest dbt run: checks failing or erroring', 'all', 'current', None, '', 'n/a', 'no runs recorded')
        return
    last = history.iloc[0]
    add('Latest dbt run: checks failing or erroring', 'all', 'current', int(last['fail']), '0', 'pass' if last['fail'] == 0 else 'fail',
        f"{int(last['checks'])} checks on {pd.Timestamp(last['run_at']).date()}")
    add('Latest dbt run: checks warning', 'all', 'current', int(last['warn']), '0', 'pass' if last['warn'] == 0 else 'warn')
    failing = con.sql(f'''
        select check_name, severity, status, failures from test_results
        where run_id = '{last['run_id']}' and resource_type = 'test' and status <> 'pass' order by status, check_name
    ''').df()
    display(failing)


for name, fn in [('Links', links), ('Freshness', freshness), ('dbt checks', dbt_checks)]:
    run(name, fn)
if len(history):
    h = history.sort_values('run_at')
    fig, ax = plt.subplots(figsize=(9, 3.5))
    ax.plot(pd.to_datetime(h['run_at']), h['warn'], marker='o', label='warn', color='#b58900')
    ax.plot(pd.to_datetime(h['run_at']), h['fail'], marker='o', label='fail or error', color='#b23a0a')
    ax.set_title('dbt checks not passing, by run')
    ax.legend()
    plt.tight_layout()
    plt.show()""",
    ),
    (
        "md",
        """## The scorecard""",
    ),
    (
        "code",
        """scorecard = pd.DataFrame(checks, columns=['check', 'league', 'season', 'value', 'threshold', 'status', 'detail'])
ORDER = {'fail': 0, 'warn': 1, 'n/a': 3, 'pass': 2}
if len(scorecard):
    counts = scorecard.pivot_table(index='league', columns='status', values='check', aggfunc='count', fill_value=0)
    display(counts)
    display(scorecard.sort_values(['league', 'season', 'check']))

games_in_build = {r[0]: r[1] for r in con.sql('select league, count(distinct game_id) from fct_player_game group by 1').fetchall()}
for lg in LEAGUES:
    part = scorecard[scorecard['league'].isin([lg, 'all'])]
    graded = part[part['status'] != 'n/a']
    n_games = games_in_build.get(lg, 0)
    if n_games < 50:
        findings[lg] = insufficient(
            f"Not enough history in this build: {n_games} {LABEL[lg]} game{'' if n_games == 1 else 's'}, too few for the checks to describe the data.",
            n=len(graded), n_label='checks graded')
        continue
    counts = graded['status'].value_counts()
    worst = graded.assign(o=graded['status'].map(ORDER)).sort_values(['o', 'season'], ascending=[True, False])
    headline = (f"{counts.get('pass', 0)} of {len(graded)} checks pass for the {LABEL[lg]} data in this build, "
                f"{counts.get('warn', 0)} warn and {counts.get('fail', 0)} fail"
                + (f"; the first to look at: {worst.iloc[0]['check'].lower()} ({worst.iloc[0]['season'] or 'all'}, {worst.iloc[0]['value']})."
                   if len(worst) and worst.iloc[0]['status'] != 'pass' else '.'))

    def latest(check):
        rows = part[(part['check'] == check) & (part['status'] != 'n/a')].sort_values('season')
        return rows.iloc[-1] if len(rows) else None

    facts = []
    for check, label in [('Played player-games matched across sources', 'Matched across sources'),
                         ('Team-games whose player rows add up', 'Box scores that add up'),
                         ('Shot chart attempts equal to the box score', 'Shot chart attempts = box score'),
                         ('Actions with five a side on the floor', 'Lineups complete'),
                         ('Current injury listings linked to a player', 'Injury listings linked'),
                         ('Latest dbt run: checks failing or erroring', 'dbt checks failing, latest run')]:
        r = latest(check)
        if r is not None:
            facts.append({'label': f"{label}{' (' + r['season'] + ')' if r['season'] not in ('', 'current') else ''}",
                          'value': f"{r['value']} ({r['status']})"})
    table = worst[worst['status'] != 'pass'].head(10)
    if table.empty:
        table = graded.head(5)
    findings[lg] = {
        'headline': headline,
        'facts': facts[:6],
        'table': {'columns': ['Check', 'Season', 'Value', 'Threshold', 'Status'],
                  'rows': [[r['check'], r['season'] or 'all', None if r['value'] is None else str(r['value']), r['threshold'], r['status']]
                           for _, r in table.iterrows()]},
        'n': int(len(graded)),
        'n_label': 'checks graded',
    }
save_findings('04_data_quality', {'title': 'Data quality scorecard', 'leagues': findings})
findings""",
    ),
]
