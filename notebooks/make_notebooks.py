"""Write the three analysis notebooks as .ipynb files (run once; the notebooks are committed).

    uv run python notebooks/make_notebooks.py

Keeping the source here, as plain Python strings, makes the notebooks reviewable in a diff and
regenerable; nbconvert executes the committed .ipynb files in CI and after every export. Every
notebook covers both leagues and ends by saving its headline findings (``fs.save_findings``),
which the site's Notebooks page shows per league next to the link to the rendered notebook.
"""

from __future__ import annotations

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent

SETUP = """import sys
sys.path.insert(0, str(__import__('pathlib').Path.cwd()))
import matplotlib.pyplot as plt
import pandas as pd
from fs import connect, describe, leagues, save_findings

pd.set_option('display.width', 160)
pd.set_option('display.max_columns', 30)
con = connect()
LEAGUES = leagues(con)
LABEL = {'wnba': 'WNBA', 'nba': 'NBA'}
COLOR = {'wnba': '#b23a0a', 'nba': '#1a7f4b'}
findings = {}
print(describe(con), 'Leagues:', ', '.join(LABEL[lg] for lg in LEAGUES))"""

NOTEBOOKS: dict[str, list[tuple[str, str]]] = {
    "01_shot_profiles": [
        (
            "md",
            """# Shot profiles: where shots are worth the most, and who beats the league there

Every shot the league tracks is tagged with a court zone. For each league this notebook takes the
latest season with a meaningful number of shots (early in a season it falls back to the last full
one), measures what a shot in each zone is worth in points per 100 attempts, and compares the
highest-volume shooters with the league in every zone. Every number comes from `fct_shot`, the
same table behind the shot charts on the site's player pages.""",
        ),
        ("code", SETUP),
        (
            "code",
            """def shot_season(lg):
    seasons = con.sql(f"select season, count(*) n from fct_shot where league = '{lg}' group by 1 order by 1 desc").fetchall()
    if len(seasons) > 1 and seasons[0][1] < 0.25 * seasons[1][1]:
        return seasons[1][0], f'{seasons[0][0]} is only {seasons[0][1]:,} shots in, so this uses {seasons[1][0]}'
    return seasons[0][0], None

zones = {}
for lg in LEAGUES:
    season, note = shot_season(lg)
    zones[lg] = (season, note, con.sql(f'''
        select shot_zone_basic as zone, count(*) as attempts,
               round(100.0 * avg(case when shot_made then 1 else 0 end), 1) as fg_pct,
               round(100.0 * avg(case when shot_made then (case when is_three then 3 else 2 end) else 0 end), 1) as pp100,
               round(100.0 * count(*) / sum(count(*)) over (), 1) as share_pct
        from fct_shot
        where league = '{lg}' and season = '{season}' and shot_zone_basic <> 'Backcourt'
        group by 1 order by pp100 desc
    ''').df())
    print(f"{LABEL[lg]} {season}" + (f" ({note})" if note else ''))
    display(zones[lg][2])""",
        ),
        (
            "code",
            """fig, axes = plt.subplots(1, len(LEAGUES), figsize=(6 * len(LEAGUES), 4), squeeze=False)
for ax, lg in zip(axes[0], LEAGUES, strict=False):
    season, _, z = zones[lg]
    ax.barh(z['zone'], z['pp100'], color=COLOR[lg])
    ax.invert_yaxis()
    ax.set_xlabel('Points per 100 attempts')
    ax.set_title(f'{LABEL[lg]} {season}')
plt.tight_layout()
plt.show()""",
        ),
        (
            "md",
            """## The highest-volume shooters, zone by zone

For the ten players with the most attempts in each league, each zone's points per 100 attempts
against the league's in that zone (zones with fewer than 15 attempts left blank), and the
weighted overall edge.""",
        ),
        (
            "code",
            """edges = {}
for lg in LEAGUES:
    season, _, _ = zones[lg]
    players = con.sql(f'''
        with per_zone as (
            select player_id, shot_zone_basic as zone, count(*) as attempts,
                   sum(case when shot_made then (case when is_three then 3 else 2 end) else 0 end) as points
            from fct_shot
            where league = '{lg}' and season = '{season}' and shot_zone_basic <> 'Backcourt'
            group by 1, 2 having count(*) >= 15
        ),
        lg_zone as (
            select shot_zone_basic as zone,
                   100.0 * avg(case when shot_made then (case when is_three then 3 else 2 end) else 0 end) as league_pp100
            from fct_shot where league = '{lg}' and season = '{season}' and shot_zone_basic <> 'Backcourt'
            group by 1
        ),
        top as (select player_id, sum(attempts) as attempts from per_zone group by 1 order by 2 desc limit 10)
        select coalesce(p.full_name, z.player_id) as player, z.zone, z.attempts,
               round(100.0 * z.points / z.attempts - l.league_pp100, 1) as edge
        from per_zone z join top using (player_id) join lg_zone l using (zone)
        left join (select stats_player_id, full_name from dim_player where league = '{lg}' and is_current) p
            on p.stats_player_id = z.player_id
    ''').df()
    overall = (players.assign(w=players['attempts'] * players['edge'])
               .groupby('player').agg(attempts=('attempts', 'sum'), weighted=('w', 'sum')))
    overall['edge_pp100'] = (overall['weighted'] / overall['attempts']).round(1)
    table = (players.pivot_table(index='player', columns='zone', values='edge', aggfunc='first')
             .join(overall[['attempts', 'edge_pp100']]).sort_values('edge_pp100', ascending=False))
    edges[lg] = table
    print(LABEL[lg]); display(table.round(1))""",
        ),
        (
            "code",
            """for lg in LEAGUES:
    season, note, z = zones[lg]
    best, worst = z.iloc[0], z.iloc[-1]
    threes = z[z['zone'].str.contains('3')]
    top = edges[lg].reset_index().head(5)
    findings[lg] = {
        'headline': f"In {season}, a {best['zone']} attempt is worth {best['pp100']:.0f} points per 100 shots, against {worst['pp100']:.0f} from {worst['zone']}.",
        'facts': [
            {'label': 'Season', 'value': season + (f' ({note})' if note else '')},
            {'label': 'Best zone', 'value': f"{best['zone']}: {best['pp100']:.1f} pts / 100"},
            {'label': 'Share of shots from three', 'value': f"{threes['share_pct'].sum():.1f}%"},
            {'label': 'Biggest edge among volume shooters', 'value': f"{top.iloc[0]['player']}: {top.iloc[0]['edge_pp100']:+.1f} pts / 100" if len(top) else 'n/a'},
        ],
        'table': {
            'columns': ['Player', 'Attempts', 'Edge (pts / 100)'],
            'rows': [[r['player'], int(r['attempts']), float(r['edge_pp100'])] for _, r in top.iterrows()],
        },
    }
save_findings('01_shot_profiles', {'title': 'Shot profiles', 'leagues': findings})
findings""",
        ),
    ],
    "02_reconciliation_audit": [
        (
            "md",
            """# Reconciliation audit: where and why the two sources disagree

Every player-game both sources report is compared on thirteen values (ADR 0005). This notebook
reads the result tables for each league: how much of each season the second source covers, how
often the sources agree, and which values differ when they do. A rising conflict rate is the first
sign one source changed shape.""",
        ),
        ("code", SETUP),
        (
            "code",
            """summary = con.sql('''
    select league, season, player_games, played_player_games, played_matched,
           round(100 * played_match_rate, 2) as played_match_pct,
           exact, minor, conflict, round(100 * coalesce(conflict_rate, 0), 3) as conflict_pct
    from reconciliation_summary order by league, season
''').df()
summary""",
        ),
        (
            "code",
            """fig, axes = plt.subplots(1, 2, figsize=(11, 4))
for lg in LEAGUES:
    part = summary[summary['league'] == lg]
    axes[0].plot(part['season'], part['played_match_pct'], marker='o', label=LABEL[lg], color=COLOR[lg])
    axes[1].plot(part['season'], part['conflict_pct'], marker='o', label=LABEL[lg], color=COLOR[lg])
axes[0].axhline(99, ls='--', color='grey', lw=1)
axes[0].set_title('Played player-games matched (%)')
axes[0].legend()
axes[1].set_title('Conflict rate among matched (%)')
for ax in axes:
    ax.tick_params(axis='x', rotation=45)
plt.tight_layout()
plt.show()""",
        ),
        (
            "md",
            """## Which values disagree

`reconciliation` holds one row per differing value with both figures and the resolution (the
league value wins; the second source fills in only where the league is null). Did-not-play lines
and minutes rounding are left out, so what remains is a genuine disagreement.""",
        ),
        (
            "code",
            """by_stat = con.sql('''
    select league, stat, count(*) as differences, round(avg(abs(delta)), 2) as mean_abs_delta,
           sum(case when resolution = 'espn' then 1 else 0 end) as filled_from_second_source
    from reconciliation group by 1, 2 order by 1, 3 desc
''').df()
by_stat""",
        ),
        (
            "code",
            """for lg in LEAGUES:
    part = summary[summary['league'] == lg]
    latest = part.iloc[-1]
    stats = by_stat[by_stat['league'] == lg]
    worst = part.sort_values('played_match_pct').iloc[0]
    findings[lg] = {
        'headline': f"{latest['played_match_pct']:.1f}% of {latest['season']} played player-games are matched across sources, and {latest['conflict_pct']:.2f}% of those disagree on a counting stat.",
        'facts': [
            {'label': 'Seasons compared', 'value': f"{len(part)} ({part['season'].iloc[0]} to {part['season'].iloc[-1]})"},
            {'label': 'Lowest coverage', 'value': f"{worst['season']}: {worst['played_match_pct']:.1f}%"},
            {'label': 'Player-games in conflict, all seasons', 'value': f"{int(part['conflict'].sum()):,} of {int(part['played_matched'].sum()):,}"},
            {'label': 'Most-disputed value', 'value': f"{stats.iloc[0]['stat']} ({int(stats.iloc[0]['differences'])} differences)" if len(stats) else 'none'},
        ],
        'table': {
            'columns': ['Season', 'Matched (played)', 'Conflict rate'],
            'rows': [[r['season'], f"{r['played_match_pct']:.1f}%", f"{r['conflict_pct']:.2f}%"] for _, r in part.iterrows()],
        },
    }
save_findings('02_reconciliation_audit', {'title': 'Reconciliation audit', 'leagues': findings})
findings""",
        ),
    ],
    "03_fantasy_value_backtest": [
        (
            "md",
            """# Fantasy value backtest: does last season predict this season?

The board blends seasons of category z-scores. The question behind the blend is how well a
ranking you could make before a season, last season's full-season z-score, predicts the value a
player goes on to produce. This notebook measures it for every pair of consecutive seasons in each
league (players with at least ten games in the later season), and names the biggest misses.""",
        ),
        ("code", SETUP),
        (
            "code",
            """z = con.sql('''
    select league, season, player_id, games, z_total
    from mart_category_zscores
    where window_name = 'season' and in_pool
''').df()
pairs, latest_pairs = [], {}
for lg in LEAGUES:
    part = z[z['league'] == lg]
    seasons = sorted(part['season'].unique())
    for prev, cur in zip(seasons, seasons[1:], strict=False):
        a = part[part['season'] == prev][['player_id', 'z_total']].rename(columns={'z_total': 'prior'})
        b = part[(part['season'] == cur) & (part['games'] >= 10)][['player_id', 'z_total', 'games']].rename(columns={'z_total': 'actual'})
        both = a.merge(b, on='player_id')
        if len(both) >= 30:
            top = both.nlargest(20, 'prior')
            pairs.append({'league': lg, 'prior_season': prev, 'season': cur, 'players': len(both),
                          'spearman': round(both[['prior', 'actual']].corr(method='spearman').iloc[0, 1], 3),
                          'top20_still_top20': int(top['player_id'].isin(both.nlargest(20, 'actual')['player_id']).sum())})
            latest_pairs[lg] = (prev, cur, both)
backtest = pd.DataFrame(pairs, columns=['league', 'prior_season', 'season', 'players', 'spearman', 'top20_still_top20'])
backtest""",
        ),
        (
            "code",
            """if len(backtest):
    fig, ax = plt.subplots(figsize=(8, 4))
    for lg in LEAGUES:
        part = backtest[backtest['league'] == lg]
        ax.plot(part['season'], part['spearman'], marker='o', label=LABEL[lg], color=COLOR[lg])
    ax.set_ylim(0, 1)
    ax.set_ylabel('Spearman rank correlation')
    ax.legend()
    ax.set_title("How well last season's z-score rank predicted the next")
    plt.tight_layout()
    plt.show()""",
        ),
        (
            "md",
            """## The biggest misses

In the most recent pair of seasons per league: the risers a preseason rank would have missed and
the fallers it would have overrated.""",
        ),
        (
            "code",
            """names = con.sql("select league, stats_player_id as player_id, full_name from dim_player where is_current").df()
moves = {}
for lg, (prev, cur, both) in latest_pairs.items():
    m = both.assign(change=both['actual'] - both['prior']).merge(
        names[names['league'] == lg][['player_id', 'full_name']], on='player_id', how='left')
    moves[lg] = m
    print(f'{LABEL[lg]}: {prev} to {cur}')
    display(m.nlargest(8, 'change')[['full_name', 'games', 'prior', 'actual', 'change']].round(2))
    display(m.nsmallest(8, 'change')[['full_name', 'games', 'prior', 'actual', 'change']].round(2))""",
        ),
        (
            "code",
            """for lg in LEAGUES:
    part = backtest[backtest['league'] == lg]
    if not len(part):
        continue
    prev, cur, _ = latest_pairs[lg]
    m = moves[lg]
    risers = m.nlargest(5, 'change')
    findings[lg] = {
        'headline': f"Last season's rank predicts the next with a rank correlation of {part['spearman'].mean():.2f} on average; {part.iloc[-1]['top20_still_top20']} of the top 20 in {prev} stayed top 20 in {cur}.",
        'facts': [
            {'label': 'Season pairs', 'value': str(len(part))},
            {'label': 'Rank correlation, latest pair', 'value': f"{part.iloc[-1]['spearman']:.2f} ({prev} to {cur})"},
            {'label': 'Best and worst pair', 'value': f"{part['spearman'].max():.2f} / {part['spearman'].min():.2f}"},
            {'label': 'Biggest riser', 'value': f"{risers.iloc[0]['full_name']}: {risers.iloc[0]['change']:+.2f}" if len(risers) else 'n/a'},
        ],
        'table': {
            'columns': ['Riser', f'{prev} value', f'{cur} value', 'Change'],
            'rows': [[r['full_name'], round(r['prior'], 2), round(r['actual'], 2), round(r['change'], 2)] for _, r in risers.iterrows()],
        },
    }
save_findings('03_fantasy_value_backtest', {'title': 'Fantasy value backtest', 'leagues': findings})
findings""",
        ),
    ],
}


def main() -> None:
    for name, cells in NOTEBOOKS.items():
        nb = nbf.v4.new_notebook()
        nb.metadata["kernelspec"] = {
            "name": "python3",
            "display_name": "Python 3",
            "language": "python",
        }
        nb.cells = [
            nbf.v4.new_markdown_cell(src) if kind == "md" else nbf.v4.new_code_cell(src)
            for kind, src in cells
        ]
        path = HERE / f"{name}.ipynb"
        nbf.write(nb, path)
        print("wrote", path.name, len(nb.cells), "cells")


if __name__ == "__main__":
    main()
