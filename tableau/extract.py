"""The gold extract behind the "League Pulse" Tableau Public workbook (SPEC.md, "Dashboard").

    uv run python tableau/extract.py [--out tableau/extract] [--source published|local]

Three CSV files, small enough for Tableau Public's free tier and refreshed after every export:

- ``team_pace_ratings.csv``: one row per team-season (games, pace, offensive, defensive and net
  rating, points for and against per game).
- ``player_value.csv``: one row per player on the board (rank, blended value, the nine category
  z-scores, games this season, team, position).
- ``data_health.csv``: one row per build (gate verdict, counts of passing, warning and failing
  checks, run time), the trend the dashboard's health panel shows.

The build workflow writes them under ``builds/<id>/tableau/`` next to the data; Tableau Public
has no scheduled refresh, so publishing is the one manual step (see README.md here).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "notebooks"))
from fs import connect

QUERIES = {
    "team_pace_ratings": """
        select
            t.league, t.season, t.team_id, t.team_abbreviation as team,
            count(*) as games,
            sum(case when t.win_loss = 'W' then 1 else 0 end) as wins,
            round(avg(t.pace), 2) as pace,
            round(avg(t.offensive_rating), 2) as offensive_rating,
            round(avg(t.defensive_rating), 2) as defensive_rating,
            round(avg(t.net_rating), 2) as net_rating,
            round(avg(t.points), 2) as points_for_pg,
            round(avg(t.opponent_points), 2) as points_against_pg
        from fct_team_game as t
        group by 1, 2, 3, 4
        order by 1, 2, 4
    """,
    "player_value": """
        select
            b.league, b.season, b.player_id, b.full_name as player, b.team_abbreviation as team,
            b.position, b.games_current as games, b.rank_total as rank,
            round(b.value_total, 3) as value_total,
            round(b.value_rest_of_season, 3) as value_rest_of_season,
            round(b.z_points, 3) as z_points, round(b.z_rebounds_total, 3) as z_rebounds,
            round(b.z_assists, 3) as z_assists, round(b.z_steals, 3) as z_steals,
            round(b.z_blocks, 3) as z_blocks, round(b.z_three_pointers_made, 3) as z_threes,
            round(b.z_field_goal_pct, 3) as z_fg_pct, round(b.z_free_throw_pct, 3) as z_ft_pct,
            round(b.z_turnovers, 3) as z_turnovers
        from mart_board as b
        order by 1, 8
    """,
    "data_health": """
        with checks as (
            select run_id,
                sum(case when status = 'pass' then 1 else 0 end) as checks_pass,
                sum(case when status = 'warn' then 1 else 0 end) as checks_warn,
                sum(case when status in ('fail', 'error') then 1 else 0 end) as checks_fail
            from test_results where resource_type = 'test' group by 1
        )
        select g.run_at, g.run_id, g.engine, g.git_sha, g.passed, g.error_failures, g.warn_failures,
               g.model_errors, c.checks_pass, c.checks_warn, c.checks_fail
        from publish_gate as g
        left join checks as c using (run_id)
        order by g.run_at
    """,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=Path("tableau/extract"))
    parser.add_argument("--source", default=None, help="published, local or databricks")
    args = parser.parse_args(argv)
    con = connect(args.source)
    args.out.mkdir(parents=True, exist_ok=True)
    for name, sql in QUERIES.items():
        target = args.out / f"{name}.csv"
        try:
            con.sql(sql).write_csv(str(target))
        except Exception as exc:
            print(f"{name}: skipped ({type(exc).__name__}: {str(exc)[:120]})")
            continue
        rows = con.sql(f"select count(*) from read_csv_auto('{target.as_posix()}')").fetchall()[0][
            0
        ]
        print(f"{target}: {rows} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
