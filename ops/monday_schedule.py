"""The week's schedule as it was published on the Monday (#1087).

    uv run python -m ops.monday_schedule export --league nba --seasons 2020-21 2021-22 \
        --full-db dbt/fantasyscout.duckdb --out monday-schedule/
    uv run python -m ops.monday_schedule apply closeness-nba-2023-24/ --schedule monday-schedule/ \
        --out monday/closeness-nba-2023-24/

The studies' weekly exports (ops.closeness_backtest, S0 #1077 and every study on it) count a
week's games from the point-in-time build's schedule, which holds each game on the date it was
played: a game postponed after the Monday sits on its new date, so the build knows on the Monday
about a move made later in the week.

``export`` writes, for the seasons given, every landing of the league's schedule with its ingest
date, and each player's team on each game day. ``apply`` writes a copy of a weekly export folder
whose ``games_this_week`` is each Monday's count as published that morning:

- **From the schedule's history,** where the schedule landed before the Monday: the newest landing
  before the Monday is the schedule as published (the live seasons, landed every day).
- **By marking the games moved after the Monday,** where it did not (the past seasons were landed
  once, after they ended): the league numbers a season's regular-season games in the order of the
  schedule it published, and a game postponed keeps its number. A game whose neighbours by number
  agree on a date and that was played more than ``SLACK`` days after them was moved; it was
  published for its neighbours' date. On a Monday whose week holds that date, and when it was
  played after that week, it counts in that week, as the Monday's schedule had it. A move is taken
  to have been made after the Monday of the week it left; a game moved earlier is left where it
  was played (its new date was published before the week it moved into). A play-in or playoff
  game counts only on a Monday after the regular season's last game, which sets its pairings.

A player's count changes by his team's change: the published count less the count as played, from
this module's own counting, added to the board's.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pandas as pd

from ops.walk_forward import LOCKED

# the games the board counts in a week (mart_board's games_this_week): the game id's third
# character, regular season, playoffs and play-in
GAME_TYPES = ("2", "4", "5")
# the games whose pairings the regular season's end sets: the playoffs, and the NBA's play-in (a
# WNBA game numbered 5 is the Commissioner's Cup final, set in June)
POSTSEASON = {"nba": ("4", "5"), "wnba": ("4",)}
# def: the games each side of a game, by number, whose dates place where it was published (#1087)
NEIGHBOURS = 3
# def: the days a game may sit beyond its neighbours' dates and still count as not moved (#1087)
SLACK = 2


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


# ---- the schedule as published ----------------------------------------------------------------


@dataclass(frozen=True)
class Schedule:
    """One league's schedule landings and players' teams, as ``export`` writes them."""

    league: str
    landings: pd.DataFrame  # season, ingest_date, game_id, game_date, home_team_id, away_team_id
    teams: pd.DataFrame  # season, game_date, player_id, team_id


def read(folder: Path) -> Schedule:
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    ids = {"game_id": str, "home_team_id": str, "away_team_id": str, "season": str}
    landings = pd.read_csv(folder / "landings.csv", dtype=ids)
    for c in ("ingest_date", "game_date"):
        landings[c] = pd.to_datetime(landings[c]).dt.date
    teams = pd.read_csv(
        folder / "teams.csv", dtype={"player_id": str, "team_id": str, "season": str}
    )
    teams["game_date"] = pd.to_datetime(teams["game_date"]).dt.date
    return Schedule(meta["league"], landings, teams)


def sunday(as_of: date) -> date:
    return as_of - timedelta(days=as_of.weekday()) + timedelta(days=6)


def moved(games: pd.DataFrame) -> pd.DataFrame:
    """The regular-season games played later than the schedule published them, from one landing
    of a season (game_id, game_date): each with ``original``, the date its neighbours by number
    give it, or none when they straddle two weeks (it cannot be placed in one)."""
    reg = games[games["game_id"].str[2] == "2"].sort_values("game_id").reset_index(drop=True)
    days = [d.toordinal() for d in reg["game_date"]]
    rows = []
    for i, d in enumerate(days):
        before = sorted(days[max(0, i - NEIGHBOURS) : i])
        after = sorted(days[i + 1 : i + 1 + NEIGHBOURS])
        if not before or not after:
            continue
        lo, hi = before[len(before) // 2], after[len(after) // 2]
        if not (0 <= hi - lo <= SLACK) or d <= hi + SLACK:
            continue  # neighbours that disagree (the edge of a block of numbers), or not moved
        first, last = date.fromordinal(lo), date.fromordinal(hi)
        rows.append(
            {
                "game_id": reg["game_id"][i],
                "game_date": reg["game_date"][i],
                "original": first if sunday(first) == sunday(last) else None,
                "home_team_id": reg["home_team_id"][i],
                "away_team_id": reg["away_team_id"][i],
            }
        )
    return pd.DataFrame(
        rows, columns=["game_id", "game_date", "original", "home_team_id", "away_team_id"]
    )


def _team_counts(games: pd.DataFrame, when: pd.Series, as_of: date) -> Counter[str]:
    week = games[(when >= as_of) & (when <= sunday(as_of))]
    return Counter(list(week["home_team_id"]) + list(week["away_team_id"]))


def week_change(s: Schedule, season: str, as_of: date) -> tuple[str, dict[str, int], Counter[str]]:
    """Each team's games in the week of ``as_of`` as the Monday's schedule had them, less as
    played (teams with no change left out); which way the Monday's schedule was read; and each
    team's games as played."""
    landed = s.landings[s.landings["season"] == season]
    final = landed[landed["ingest_date"] == landed["ingest_date"].max()].drop_duplicates("game_id")
    before = landed[landed["ingest_date"] < as_of]
    if len(before):
        source = "history"
        known = before[before["ingest_date"] == before["ingest_date"].max()]
        known = known.drop_duplicates("game_id")
        published = _team_counts(known, known["game_date"], as_of)
    else:
        source = "marked"
        m = moved(final).set_index("game_id")["original"]
        orig = final["game_id"].map(m)
        placed = [
            o if isinstance(o, date) and as_of <= o <= sunday(as_of) < d else d
            for o, d in zip(orig, final["game_date"], strict=True)
        ]
        # the play-in's and the playoffs' pairings are set by the regular season's last games:
        # before those are played, the Monday's schedule has none of them for any team
        regular = final["game_id"].str[2] == "2"
        later = final["game_id"].str[2].isin(POSTSEASON[s.league])
        if final.loc[regular, "game_date"].max() >= as_of:
            placed = [date.max if p else d for d, p in zip(placed, later, strict=True)]
        published = _team_counts(final, pd.Series(placed, index=final.index), as_of)
    played = _team_counts(final, final["game_date"], as_of)
    teams = set(published) | set(played)
    change = {t: published[t] - played[t] for t in sorted(teams) if published[t] != played[t]}
    return source, change, played


def player_teams(s: Schedule, as_of: date) -> dict[str, str]:
    """Each player's team on the Monday: that of his latest game before it."""
    before = s.teams[s.teams["game_date"] < as_of].sort_values("game_date")
    return dict(zip(before["player_id"], before["team_id"], strict=True))


def apply(folder: Path, s: Schedule, out: Path) -> dict[str, Any]:
    """A copy of a weekly export folder (meta.json and players-<day>.csv, as ops.closeness_backtest
    and ops.s2_minutes write them) with each Monday's games_this_week as published that morning.
    Files with nothing to change are copied as they are. Returns what changed."""
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    if meta["league"] != s.league:
        raise SystemExit(f"{folder}: {meta['league']}, the schedule is {s.league}")
    if meta.get("schedule") == "monday":
        raise SystemExit(f"{folder}: already the Monday's schedule")
    if out.exists():
        raise SystemExit(f"{out}: exists")
    shutil.copytree(folder, out)
    weeks = []
    for text in meta["weeks"]:
        as_of = date.fromisoformat(text)
        source, change, played = week_change(s, meta["season"], as_of)
        if not change:
            continue
        path = out / f"players-{text}.csv"
        df = pd.read_csv(path, dtype={"player_id": str})
        team = df["player_id"].map(player_teams(s, as_of))
        delta = team.map(change).fillna(0).astype(int)
        # a player moved whose board count is not his team's as played: his team is misread
        on = delta != 0
        misread = int((df["games_this_week"][on] != team[on].map(played)).sum())
        df["games_this_week"] = df["games_this_week"] + delta
        df.to_csv(path, index=False)
        weeks.append(
            {
                "week": text,
                "source": source,
                "teams": change,
                "players_changed": int(on.sum()),
                "players_misread": misread,
            }
        )
    meta["schedule"] = "monday"
    (out / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    report = {"league": meta["league"], "season": meta["season"], "weeks": weeks}
    (out / "monday-schedule.json").write_text(json.dumps(report, indent=1) + "\n", "utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.monday_schedule")
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="the schedule's landings and players' teams (the runner)")
    e.add_argument("--league", choices=("nba", "wnba"), required=True)
    e.add_argument("--seasons", nargs="+", required=True)
    e.add_argument("--full-db", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    a = sub.add_parser("apply", help="a weekly export with each Monday's schedule as published")
    a.add_argument("folder", type=Path)
    a.add_argument("--schedule", type=Path, required=True)
    a.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.cmd == "export":
        if LOCKED[args.league] in args.seasons:
            print(f"{args.league} {LOCKED[args.league]} is locked (#751)", file=sys.stderr)
            return 2
        export(args.full_db, args.league, args.seasons, args.out)
        return 0
    report = apply(args.folder, read(args.schedule), args.out)
    for w in report["weeks"]:
        print(
            f"{report['season']} {w['week']} ({w['source']}): {w['teams']}, "
            f"{w['players_changed']} players, {w['players_misread']} misread"
        )
    print(f"{report['league']} {report['season']}: {len(report['weeks'])} weeks changed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
