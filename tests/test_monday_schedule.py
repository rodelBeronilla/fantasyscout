"""The week's schedule as published on the Monday (#1087): moved games, the schedule's history,
and the weekly export rewritten with it. Invented teams and games only."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

from ops import monday_schedule as ms

MONDAY = date(2024, 1, 15)
TEAMS = ["A", "B", "C", "D", "E", "F"]


def day(n: int) -> date:
    return MONDAY + timedelta(days=n)


def season(moves: dict[int, int] | None = None, ingest: date = date(2026, 10, 27)) -> pd.DataFrame:
    """Three games a day for four weeks from two weeks before the Monday, numbered in date order;
    ``moves`` plays game number n on day m instead."""
    rows = []
    n = 0
    for d in range(-14, 14):
        for k in range(3):
            n += 1
            home, away = TEAMS[(d + 2 * k) % 6], TEAMS[(d + 2 * k + 1) % 6]
            when = day((moves or {}).get(n, d))
            rows.append(("2023-24", ingest, f"00223{n:05d}", when, home, away))
    cols = ["season", "ingest_date", "game_id", "game_date", "home_team_id", "away_team_id"]
    return pd.DataFrame(rows, columns=cols)


def schedule(landings: pd.DataFrame) -> ms.Schedule:
    teams = pd.DataFrame(
        [("2023-24", day(-1), "p1", "A"), ("2023-24", day(-1), "p2", "C")],
        columns=["season", "game_date", "player_id", "team_id"],
    )
    return ms.Schedule("nba", landings, teams)


def game_on(df: pd.DataFrame, d: int, team: str = "A") -> int:
    """The number of team's game on day d of the as-played season."""
    row = df[
        (df["game_date"] == day(d)) & ((df["home_team_id"] == team) | (df["away_team_id"] == team))
    ]
    return int(row["game_id"].iloc[0][5:])


def test_a_game_played_weeks_later_keeps_its_number_and_is_put_back_on_its_date() -> None:
    base = season()
    n = game_on(base, 2)  # A's Wednesday game, postponed three weeks
    m = ms.moved(season({n: 23}))
    assert m["game_id"].tolist() == [f"00223{n:05d}"]
    assert m["original"].tolist() == [day(2)]


def test_a_game_a_day_late_or_at_the_edge_of_a_block_of_numbers_is_not_moved() -> None:
    base = season()
    late = game_on(base, 2)
    assert ms.moved(season({late: 3})).empty  # within SLACK of its neighbours
    # numbers out of date order in a block (a tournament's games numbered first): no neighbours
    # agree at the block's edges, so nothing there is marked
    block = season({k: 13 for k in range(1, 4)})
    assert ms.moved(block)["game_id"].str[5:].astype(int).gt(3).all()


def test_the_mondays_count_keeps_a_game_postponed_after_the_monday() -> None:
    base = season()
    n = game_on(base, 2)
    s = schedule(season({n: 23}))
    source, change, played = ms.week_change(s, "2023-24", MONDAY)
    assert source == "marked"
    home, away = base.loc[n - 1, ["home_team_id", "away_team_id"]]
    assert change == {home: 1, away: 1}  # as played, each team has one game fewer that week
    assert played[home] == ms._team_counts(base, base["game_date"], MONDAY)[home] - 1


def test_a_move_after_the_monday_moves_no_count_and_one_before_it_does() -> None:
    """Without the schedule's history: a game of the Monday's week postponed three weeks moves
    none of that Monday's counts; the same move made on a game of the week before (made before the
    Monday, into its week) does (positive control)."""
    base = season()
    as_published = ms._team_counts(base, base["game_date"], MONDAY)

    def mondays(moves: dict[int, int]) -> dict[str, int]:
        _, change, played = ms.week_change(schedule(season(moves)), "2023-24", MONDAY)
        return {t: played[t] + change.get(t, 0) for t in TEAMS}

    assert mondays({game_on(base, 2): 23}) == dict(as_published)
    assert mondays({game_on(base, -2): 2}) != dict(as_published)


def test_no_number_moves_on_a_later_landing_and_one_does_a_day_before_the_monday() -> None:
    """The schedule's history: the newest landing before the Monday is the Monday's schedule. A
    landing that moves a game, planted on the Monday, moves no count; planted the day before, it
    does (positive control)."""
    early = season(ingest=day(-7))
    published = ms._team_counts(early, early["game_date"], MONDAY)
    n = game_on(early, 2)
    for planted, moves in ((day(0), False), (day(-1), True)):
        later = season({n: 23}, ingest=planted)
        s = schedule(pd.concat([early, later], ignore_index=True))
        source, change, played = ms.week_change(s, "2023-24", MONDAY)
        assert source == "history"
        mondays = {t: played[t] + change.get(t, 0) for t in TEAMS}
        assert (mondays != dict(published)) is moves


def _export(folder: Path) -> None:
    folder.mkdir()
    meta = {"league": "nba", "season": "2023-24", "weeks": [MONDAY.isoformat(), day(7).isoformat()]}
    (folder / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    for d in (MONDAY, day(7)):
        pd.DataFrame(
            {
                "player_id": ["p1", "p2", "p9"],
                "games_this_week": [3, 3, 2],
                "z_points": [1.5, 0.25, 0],
            }
        ).to_csv(folder / f"players-{d.isoformat()}.csv", index=False)
    (folder / "weeks.csv").write_text("player_id,week\n", encoding="utf-8")


def test_apply_rewrites_only_the_moved_week_and_marks_the_copy(tmp_path: Path) -> None:
    s = schedule(season({game_on(season(), 2): 23}))  # A's Wednesday game, against B
    src, out = tmp_path / "export", tmp_path / "monday"
    _export(src)
    report = ms.apply(src, s, out)
    assert [w["week"] for w in report["weeks"]] == [MONDAY.isoformat()]
    df = pd.read_csv(out / f"players-{MONDAY.isoformat()}.csv", dtype={"player_id": str})
    assert df["games_this_week"].tolist() == [4, 3, 2]  # A's player gets the game back
    for name in (f"players-{day(7).isoformat()}.csv", "weeks.csv"):
        assert (out / name).read_bytes() == (src / name).read_bytes()
    assert json.loads((out / "meta.json").read_text())["schedule"] == "monday"
    with pytest.raises(SystemExit):
        ms.apply(out, s, tmp_path / "again")


def test_a_playoff_game_counts_only_once_the_regular_season_is_over() -> None:
    base = season()  # the regular season's games run to day 13; day 14 is a Monday
    cols = base.columns
    ingest = base["ingest_date"][0]
    playoff = pd.DataFrame([("2023-24", ingest, "0042300101", day(20), "A", "B")], columns=cols)
    over = schedule(pd.concat([base, playoff], ignore_index=True))
    assert ms.week_change(over, "2023-24", day(14))[1] == {}
    # one regular-season game left on day 15: on the Monday the pairings are not set yet
    last = pd.DataFrame([("2023-24", ingest, "0022399999", day(15), "C", "D")], columns=cols)
    open_ = schedule(pd.concat([base, last, playoff], ignore_index=True))
    assert ms.week_change(open_, "2023-24", day(14))[1] == {"A": -1, "B": -1}
