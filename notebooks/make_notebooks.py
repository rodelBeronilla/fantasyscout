"""Write the three analysis notebooks as .ipynb files (run once; the notebooks are committed).

    uv run python notebooks/make_notebooks.py

Keeping the source here, as plain Python strings, makes the notebooks reviewable in a diff and
regenerable; nbconvert executes the committed .ipynb files in CI and after every export.
"""

from __future__ import annotations

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent

SETUP = """import sys
sys.path.insert(0, str(__import__('pathlib').Path.cwd()))
import matplotlib.pyplot as plt
import pandas as pd
from fs import connect, describe

pd.set_option('display.width', 160)
pd.set_option('display.max_columns', 30)
con = connect()
print(describe(con))"""

NOTEBOOKS: dict[str, list[tuple[str, str]]] = {
    "01_shot_profiles": [
        (
            "md",
            """# Shot profiles: zone efficiency against the league

Where do players shoot from, and how well, compared with the league in the same zone? The league
stats API tags every shot with a court zone; this notebook takes the current WNBA season,
measures each zone's league-wide efficiency, then compares the highest-volume shooters with it.

Every number comes from `fct_shot`, the gold shot fact the site's player pages also read.""",
        ),
        ("code", SETUP),
        (
            "code",
            """league = 'wnba'
season = con.sql(f"select max(season) from fct_shot where league = '{league}'").fetchall()[0][0]
print(f"{league.upper()} season {season}")

league_zones = con.sql(f'''
    select shot_zone_basic as zone,
           count(*) as attempts,
           sum(case when shot_made then 1 else 0 end) as made,
           round(100.0 * sum(case when shot_made then 1 else 0 end) / count(*), 1) as fg_pct,
           round(100.0 * sum(case when shot_made then (case when is_three then 3 else 2 end) else 0 end) / count(*), 1) as points_per_100
    from fct_shot
    where league = '{league}' and season = '{season}' and shot_zone_basic <> 'Backcourt'
    group by 1 order by attempts desc
''').df()
league_zones""",
        ),
        (
            "code",
            """fig, ax = plt.subplots(figsize=(8, 4))
ax.barh(league_zones['zone'], league_zones['points_per_100'], color='#b23a0a')
ax.set_xlabel('Points per 100 attempts')
ax.set_title(f'{league.upper()} {season}: value of a shot by zone')
ax.invert_yaxis()
for i, (v, n) in enumerate(zip(league_zones['points_per_100'], league_zones['attempts'])):
    ax.text(v + 1, i, f"{v:.0f}  ({n:,} att.)", va='center', fontsize=9)
ax.set_xlim(0, league_zones['points_per_100'].max() * 1.3)
plt.tight_layout()
plt.show()""",
        ),
        (
            "md",
            """## The highest-volume shooters, zone by zone

For the ten players with the most attempts, each zone's efficiency against the league's in that
zone (zones with fewer than 15 attempts are left blank). A positive difference is a zone the player
beats the league in; the weighted sum over all zones is the player's overall edge in points per 100
attempts.""",
        ),
        (
            "code",
            """players = con.sql(f'''
    with per_zone as (
        select s.player_id, s.shot_zone_basic as zone, count(*) as attempts,
               sum(case when shot_made then (case when is_three then 3 else 2 end) else 0 end) as points
        from fct_shot s
        where s.league = '{league}' and s.season = '{season}' and s.shot_zone_basic <> 'Backcourt'
        group by 1, 2
        having count(*) >= 15
    ),
    league as (
        select shot_zone_basic as zone,
               100.0 * sum(case when shot_made then (case when is_three then 3 else 2 end) else 0 end) / count(*) as league_pp100
        from fct_shot where league = '{league}' and season = '{season}' and shot_zone_basic <> 'Backcourt'
        group by 1
    ),
    top as (
        select player_id, sum(attempts) as attempts from per_zone group by 1 order by 2 desc limit 10
    )
    select coalesce(p.full_name, z.player_id) as player, z.zone, z.attempts,
           round(100.0 * z.points / z.attempts, 1) as pp100,
           round(l.league_pp100, 1) as league_pp100,
           round(100.0 * z.points / z.attempts - l.league_pp100, 1) as edge
    from per_zone z
    join top t using (player_id)
    join league l using (zone)
    left join (select league, stats_player_id, full_name from dim_player where is_current) p
        on p.league = '{league}' and p.stats_player_id = z.player_id
    order by player, z.attempts desc
''').df()
pivot = players.pivot_table(index='player', columns='zone', values='edge', aggfunc='first')
overall = (players.assign(w=players['attempts'] * players['edge'])
                  .groupby('player').agg(attempts=('attempts', 'sum'), weighted=('w', 'sum')))
overall['edge_pp100'] = (overall['weighted'] / overall['attempts']).round(1)
pivot.join(overall[['attempts', 'edge_pp100']]).sort_values('edge_pp100', ascending=False).round(1)""",
        ),
        (
            "md",
            """## Reading it

The zone table above says what a shot is worth where it is taken; the player table says who
beats that baseline and where. The same zone efficiencies, with each player's own, appear under
the shot chart on the site's player pages, so a reader can go from a name here to the chart there.""",
        ),
    ],
    "02_reconciliation_audit": [
        (
            "md",
            """# Reconciliation audit: where and why the two sources disagree

Every player-game both sources report is compared on thirteen values (ADR 0005). This notebook
reads the result tables: how much of each season ESPN covers, how often the sources agree, and
which values differ when they do. A rising conflict rate is the first sign one source changed shape.""",
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
for league, color in (('wnba', '#b23a0a'), ('nba', '#1a7f4b')):
    part = summary[summary['league'] == league]
    axes[0].plot(part['season'], part['played_match_pct'], marker='o', label=league.upper(), color=color)
    axes[1].plot(part['season'], part['conflict_pct'], marker='o', label=league.upper(), color=color)
axes[0].axhline(99, ls='--', color='grey', lw=1); axes[0].set_title('Played player-games matched (%)'); axes[0].legend()
axes[1].set_title('Conflict rate among matched (%)')
for ax in axes: ax.tick_params(axis='x', rotation=45)
plt.tight_layout(); plt.show()""",
        ),
        (
            "md",
            """## Which values disagree

`reconciliation` holds one row per differing value with both figures and the resolution
(the league value wins; ESPN fills in only where the league is null). Did-not-play lines and
minutes rounding are left out, so what remains is a genuine disagreement.""",
        ),
        (
            "code",
            """by_stat = con.sql('''
    select stat, count(*) as differences,
           round(avg(abs(delta)), 2) as mean_abs_delta,
           sum(case when resolution = 'espn' then 1 else 0 end) as espn_filled_a_null
    from reconciliation group by 1 order by 2 desc
''').df()
by_stat""",
        ),
        (
            "code",
            """by_team = con.sql('''
    select r.league, r.season, g.team_tricode, count(*) as differences,
           count(distinct r.game_id) as games
    from reconciliation r
    join fct_player_game g on g.league = r.league and g.game_id = r.game_id and g.player_id = r.stats_player_id
    group by 1, 2, 3 order by differences desc limit 15
''').df()
by_team""",
        ),
        (
            "code",
            """sample = con.sql('''
    select r.league, r.season, r.game_id, coalesce(p.full_name, r.stats_player_id) as player,
           r.stat, r.stats_value, r.espn_value, r.delta, r.resolution
    from reconciliation r
    left join (select league, stats_player_id, full_name from dim_player where is_current) p
      on p.league = r.league and p.stats_player_id = r.stats_player_id
    order by abs(r.delta) desc nulls last limit 12
''').df()
sample""",
        ),
        (
            "md",
            """## Reading it

Coverage under 99% in a season means ESPN is missing games (its box score returns nothing for a
small share of events) or players the crosswalk could not pair; `player_xwalk_review` in silver
names the players. Conflicts cluster on a few games, which is what a scoring correction by one
source and not the other looks like. The Data Health page shows the same summary table.""",
        ),
    ],
    "03_fantasy_value_backtest": [
        (
            "md",
            """# Fantasy value backtest: did last season's ranks predict this season's value?

The board ranks players by a blend of season z-scores (`mart_board`). The natural question is
whether a ranking you could have made before the season (here, last season's full-season
z-score) predicted the value a player went on to produce. This notebook measures that for every
pair of consecutive seasons in the data, per league.""",
        ),
        ("code", SETUP),
        (
            "code",
            """z = con.sql('''
    select league, season, player_id, games, z_total
    from mart_category_zscores
    where window_name = 'season' and in_pool
''').df()
pairs = []
for league, part in z.groupby('league'):
    seasons = sorted(part['season'].unique())
    for prev, cur in zip(seasons, seasons[1:]):
        a = part[part['season'] == prev][['player_id', 'z_total']].rename(columns={'z_total': 'prior'})
        b = part[part['season'] == cur][['player_id', 'z_total', 'games']].rename(columns={'z_total': 'actual'})
        b = b[b['games'] >= 10]  # a handful of games is noise, not a season
        both = a.merge(b, on='player_id')
        if len(both) >= 30:
            rho = both[['prior', 'actual']].corr(method='spearman').iloc[0, 1]
            top = both.nlargest(20, 'prior')
            pairs.append({'league': league, 'prior_season': prev, 'season': cur, 'players': len(both),
                          'spearman': round(rho, 3),
                          'top20_prior_still_top20': int(top['player_id'].isin(both.nlargest(20, 'actual')['player_id']).sum())})
backtest = pd.DataFrame(pairs)
backtest""",
        ),
        (
            "code",
            """if len(backtest):
    fig, ax = plt.subplots(figsize=(8, 4))
    for league, color in (('wnba', '#b23a0a'), ('nba', '#1a7f4b')):
        part = backtest[backtest['league'] == league]
        ax.plot(part['season'], part['spearman'], marker='o', label=league.upper(), color=color)
    ax.set_ylim(0, 1); ax.set_ylabel('Spearman rank correlation'); ax.legend()
    ax.set_title('How well last season\\'s z-score rank predicted this season\\'s')
    plt.tight_layout(); plt.show()
else:
    print('Not enough consecutive seasons in this copy of the data to backtest.')""",
        ),
        (
            "md",
            """## The biggest misses

Players whose actual value was furthest from what the prior season suggested, in the most recent
pair of seasons with at least ten games played, per league: the risers a preseason rank would have missed and the fallers it would
have overrated.""",
        ),
        (
            "code",
            """rows = []
for league, part in z.groupby('league'):
    seasons = sorted(part['season'].unique())
    both = None
    for prev, cur in reversed(list(zip(seasons, seasons[1:]))):  # the latest pair with a full season behind it
        a = part[part['season'] == prev][['player_id', 'z_total']].rename(columns={'z_total': 'prior'})
        b = part[part['season'] == cur][['player_id', 'z_total', 'games']].rename(columns={'z_total': 'actual'})
        b = b[b['games'] >= 10]
        both = a.merge(b, on='player_id')
        if len(both) >= 30:
            break
        both = None
    if both is None:
        continue
    both['league'] = league; both['season'] = cur
    both['change'] = both['actual'] - both['prior']
    rows.append(both)
if rows:
    moves = pd.concat(rows)
    names = con.sql("select league, stats_player_id as player_id, full_name from dim_player where is_current").df()
    moves = moves.merge(names, on=['league', 'player_id'], how='left')
    display(moves.nlargest(10, 'change')[['league', 'season', 'full_name', 'games', 'prior', 'actual', 'change']].round(2))
    display(moves.nsmallest(10, 'change')[['league', 'season', 'full_name', 'games', 'prior', 'actual', 'change']].round(2))""",
        ),
        (
            "md",
            """## Reading it

A rank correlation around 0.6 to 0.7 is the usual finding for season-to-season fantasy value:
the prior season is a strong but far from perfect guide, and most of the error sits in minutes
(role changes, injuries), which is exactly what the board's rolling-minutes signal on the
Streamers page tries to catch early.""",
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
