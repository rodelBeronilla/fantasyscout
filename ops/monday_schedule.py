"""The week's schedule as it was published on the Monday (#1087).

    uv run python -m ops.monday_schedule export --league nba --seasons 2020-21 2021-22 \
        --full-db dbt/fantasyscout.duckdb --out monday-schedule/

The studies' weekly exports (ops.closeness_backtest, S0 #1077 and every study on it) count a
week's games from the point-in-time build's schedule, which holds each game on the date it was
played: a game postponed after the Monday sits on its new date, so the build knows on the Monday
about a move made later in the week. ``export`` writes, for the seasons given, every landing of the
league's schedule with its ingest date, and each player's team by game day, so the harness can
rebuild each Monday's schedule as it stood that morning.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ops.walk_forward import LOCKED

# the games the board counts in a week (mart_board's games_this_week)
GAME_TYPES = ("2", "4", "5")  # regular season, playoffs, play-in: the game id's third character


def export(full_db: Path, league: str, seasons: list[str], out: Path) -> None:
    """Every landing's schedule rows (bronze, one row per game per landed file) and each player's
    team on each game day, for the seasons given. Public schedule and box-score facts only."""
    import duckdb

    out.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(full_db), read_only=True) as full:
        landings = full.execute(
            """
            select distinct season, cast(_ingest_date as date) as ingest_date, _source_file,
                game_id, game_code, cast(substr(game_date_est, 1, 10) as date) as game_date,
                game_status, game_status_text, postponed_status, game_sequence, week_number,
                if_necessary, home_team_id, away_team_id
            from bronze.stats_scheduleleaguev2
            where league = $league and season in (select unnest($seasons))
                and substr(game_id, 3, 1) in (select unnest($types))
            order by season, game_id, ingest_date
            """,
            {"league": league, "seasons": seasons, "types": list(GAME_TYPES)},
        ).fetchdf()
        teams = full.execute(
            """
            select distinct season, game_date, player_id, team_id
            from gold.fct_player_game
            where league = $league and season in (select unnest($seasons))
                and substr(game_id, 3, 1) in (select unnest($types))
            order by game_date, player_id
            """,
            {"league": league, "seasons": seasons, "types": list(GAME_TYPES)},
        ).fetchdf()
    landings.to_csv(out / "landings.csv", index=False)
    teams.to_csv(out / "teams.csv", index=False)
    files = landings.groupby("season")["_source_file"].nunique().to_dict()
    meta = {"league": league, "seasons": seasons, "landed_files": files}
    (out / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    print(f"{league} {seasons}: {len(landings)} schedule rows in {files} files, {len(teams)} teams")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.monday_schedule")
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="the schedule's landings and players' teams (the runner)")
    e.add_argument("--league", choices=("nba", "wnba"), required=True)
    e.add_argument("--seasons", nargs="+", required=True)
    e.add_argument("--full-db", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if LOCKED[args.league] in args.seasons:
        print(f"{args.league} {LOCKED[args.league]} is locked (#751)", file=sys.stderr)
        return 2
    export(args.full_db, args.league, args.seasons, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
