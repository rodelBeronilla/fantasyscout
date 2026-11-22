"""S2 (#1080): a teammate's minutes when a 28-minute player is out. Invented players only."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ops import s2_minutes as s2
from ops import week_yardstick as wy
from ops.closeness_backtest import NAIVE
from ops.matchup import LINE
from ops.standings import CATS
from ops.standings_backtest import STATS

SEASON = "2025-26"
DAYS = [date(2025, 11, 1) + timedelta(days=2 * i) for i in range(10)]  # games 1 to 10


def _row(
    season: str, team: str, n: int, day: date, pid: str, minutes: float | None, **kw: bool
) -> dict[str, object]:
    return {
        "season": season,
        "game_id": f"00225{n:05d}" if season == SEASON else f"00224{n:05d}",
        "game_date": day,
        "team_id": team,
        "player_id": pid,
        "played": minutes is not None,
        "minutes": 0.0 if minutes is None else float(minutes),
        "starter": kw.get("starter", False),
        "coach": kw.get("coach", False),
    }


def _mart_example() -> s2.History:
    """The minutes redistribution model's own unit test (its _minutes_redistribution.yml), in
    game rows: a plays 30 in games 1 to 5 and misses 6 to 8; e is sat by the coach in 1 to 5 and
    plays 10 after; b goes 20 to 28, c 10 to 12; d misses 6 to 8 himself; g is now on U. A season
    two back (2023-24) is out of the span; last season (2024-25) holds only another team."""
    rows = [
        {**_row("2023-24", "T", 1, date(2023, 11, 1), "a", 30), "game_id": "0022300001"},
        {**_row("2023-24", "T", 1, date(2023, 11, 1), "b", 40), "game_id": "0022300001"},
        _row("2024-25", "U", 1, date(2024, 11, 1), "x", 25),
    ]
    for n, day in enumerate(DAYS[:8], start=1):
        late = n > 5
        rows += [
            _row(SEASON, "T", n, day, "a", None if late else 30),
            _row(SEASON, "T", n, day, "b", 28 if late else 20),
            _row(SEASON, "T", n, day, "c", 12 if late else 10),
            _row(SEASON, "T", n, day, "e", 10 if late else None, coach=not late),
            _row(SEASON, "T", n, day, "g", 25 if late else 5),
        ]
        if not late:
            rows.append(_row(SEASON, "T", n, day, "d", 15))
    return _history(rows)


def _history(rows: list[dict[str, object]]) -> s2.History:
    g = pd.DataFrame(rows)
    return s2.History(sorted(set(g["season"])), g)


def _board(**games: float) -> s2.Board:
    team = {p: "T" for p in "abcde"} | {"g": "U", "x": "U"}
    return s2.Board(
        team=team,
        games={p: games.get(p, 3.0) for p in team},
        pool=frozenset(team),
    )


AS_OF = date(2025, 11, 17)  # the day after game 8


def test_with_and_without_are_the_minutes_redistribution_models_own() -> None:
    inp = s2.inputs(_mart_example(), SEASON, AS_OF, _board())
    assert inp.absent == ("a",)
    got = {p.teammate: p for p in inp.pairs}
    # the model's expected rows: e +10, b +8, c +2, each 5 games with him and 3 without
    assert {j: (got[j].n_with, got[j].n_without, got[j].gain) for j in "bce"} == {
        "b": (5, 3, 8.0),
        "c": (5, 3, 2.0),
        "e": (5, 3, 10.0),
    }
    # d missed the three himself: no split without him; g is on another team now
    assert got["d"].n_without == 0
    assert "g" not in got
    # the prior pools every 28-minute player's teammates, g included (+20), by games without him
    assert inp.prior == pytest.approx(((3 * 8 + 3 * 2 + 3 * 10 + 3 * 20) / 12, 0.0))


def test_the_projection_already_sees_the_absence_in_the_last_five() -> None:
    inp = s2.inputs(_mart_example(), SEASON, AS_OF, _board())
    got = {p.teammate: p.unseen for p in inp.pairs}
    # b and c's last five are games 4 to 8, three without a: 1 - 0.5 x 3/5
    assert got["b"] == pytest.approx(0.7)
    assert got["c"] == pytest.approx(0.7)
    # e has played only three games: the projection reads no last five for him
    assert got["e"] == 1.0
    # d's last five are games 1 to 5, all with a
    assert got["d"] == 1.0


def test_the_gain_is_shrunk_toward_the_class_prior() -> None:
    inp = s2.inputs(_mart_example(), SEASON, AS_OF, _board())
    players = ["b", "c", "d", "e", "a"]
    assert s2.gains(inp, players, 0.0) == pytest.approx([0.7 * 8, 0.7 * 2, 10.0, 10.0, 0.0])
    assert s2.gains(inp, players, 3.0) == pytest.approx(
        [0.7 * (3 * 8 + 3 * 10) / 6, 0.7 * (3 * 2 + 3 * 10) / 6, 10.0, 10.0, 0.0]
    )
    assert s2.gains(inp, players, float("inf")) == pytest.approx([7.0, 7.0, 10.0, 10.0, 0.0])


def test_an_absence_must_be_known_on_monday() -> None:
    h = _mart_example()
    # one game this week: he cannot miss two of them
    assert s2.inputs(h, SEASON, AS_OF, _board(a=1.0)).absent == ()
    # before game 7 he has missed one of the team's last two games, not both
    assert s2.inputs(h, SEASON, DAYS[6], _board()).absent == ()
    # before game 8 he has missed games 6 and 7
    assert s2.inputs(h, SEASON, DAYS[7], _board()).absent == ("a",)
    # under 28 minutes he does not count
    low = h.games.copy()
    low.loc[(low["player_id"] == "a") & low["played"], "minutes"] = 27.0
    assert s2.inputs(s2.History(h.seasons, low), SEASON, AS_OF, _board()).absent == ()


def _monday(
    as_of: date, players: list[str], gain: np.ndarray, real_minutes: np.ndarray
) -> s2.Monday:
    n = len(players)
    line = np.tile(np.array([20, 5, 4, 1, 1, 2, 2, 8, 16, 3, 4], dtype=float), (n, 1))
    return s2.Monday(
        as_of=as_of,
        players=players,
        line=line,
        naive=line,
        card=np.full(n, 3.0),
        scheduled=np.full(n, 3.0),
        real=line * 3,
        proj_minutes=np.full(n, 20.0),
        real_minutes=real_minutes,
        gain={k: gain for k in s2.KS},
        absent=("a",),
    )


def test_the_line_moves_with_the_minutes_and_percentages_do_not() -> None:
    m = _monday(AS_OF, ["b", "c"], np.array([10.0, -40.0]), np.zeros(2))
    line = s2.study_line(m, "nba", 0.0, 0.5)
    # b: 20 + 0.5 x 10 = 25 minutes, a quarter more of everything; c: never below none
    assert line[0] == pytest.approx(m.line[0] * 1.25)
    assert line[1] == pytest.approx(np.zeros(11))
    assert line[0, 7] / line[0, 8] == m.line[0, 7] / m.line[0, 8]
    assert s2.study_minutes(m, "wnba", 0.0, 10.0)[0] == 40.0


def test_the_leak_check_passes_honest_inputs_and_catches_a_planted_leak() -> None:
    h = _mart_example()
    # games 9 and 10 after the Monday: a is back for both
    later = []
    for n, day in ((9, DAYS[8]), (10, DAYS[9])):
        later += [_row(SEASON, "T", n, day, p, 30) for p in "abcde"]
    h = _history([*h.games.to_dict("records"), *later])
    monday = DAYS[8]  # game 9 is that day: it must not count
    week = [(_monday(monday, ["b", "c", "d", "e"], np.zeros(4), np.zeros(4)), _board())]
    assert s2.leak_check(h, SEASON, week) == 1

    def leaky(h: s2.History, season: str, as_of: date, board: s2.Board) -> s2.Inputs:
        return s2.inputs(h, season, as_of + timedelta(days=3), board)

    with pytest.raises(SystemExit, match="saw the future"):
        s2.leak_check(h, SEASON, week, inputs_fn=leaky)


def test_the_bar_needs_a_quarter_of_the_noise_and_an_interval_below_zero() -> None:
    def cat(name: str, diff: float, high: float) -> wy.Category:
        return wy.Category(name, 1.0 + diff, 1.0, 0, 0, diff, diff - 0.1, high, 0, 0, 0, 0)

    noise = dict.fromkeys(wy.CATEGORIES, 0.4)
    good = [cat(c, -0.2, -0.01) for c in wy.CATEGORIES[:7]] + [
        cat(c, 0.0, 0.0) for c in wy.CATEGORIES[7:]
    ]
    assert s2.apply_bar(good, noise)[1] == []
    short = [cat("PTS", -0.05, -0.01), *good[1:]]
    assert s2.apply_bar(short, noise)[1][0].startswith("PTS")
    worse = [*good[:7], cat("FG%", 0.5, 0.6), good[8]]
    assert "more than its noise" in s2.apply_bar(worse, noise)[1][0]


def _write_export(folder: Path) -> None:
    """A two-Monday export in ops.s2_minutes' layout, from the model's example."""
    folder.mkdir()
    h = _mart_example()
    h.games.to_csv(folder / "games.csv", index=False)
    weeks = [AS_OF, AS_OF + timedelta(days=7)]
    meta = {"league": "nba", "season": SEASON, "weeks": [d.isoformat() for d in weeks]}
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    ids = ["a", "b", "c", "d", "e", "g"]
    for d in weeks:
        df = pd.DataFrame({"player_id": ids})
        for i, c in enumerate(CATS):
            df[c] = [6.0 - j + 0.01 * i for j in range(len(ids))]
        for c in (*LINE, *NAIVE):
            df[c] = 2.0
        df["games_this_week"] = 3
        df["injury_group"] = None
        df.to_csv(folder / f"players-{d.isoformat()}.csv", index=False)
        extra = pd.DataFrame(
            {"player_id": ids, "team_id": ["T"] * 5 + ["U"], "proj_minutes_pg": 20.0}
        )
        extra.to_csv(folder / f"s2-{d.isoformat()}.csv", index=False)
    real = pd.DataFrame(
        [{"player_id": p, "week": AS_OF, "games": 3, **dict.fromkeys(STATS, 3.0)} for p in ids]
    )
    real.to_csv(folder / "weeks.csv", index=False)


def test_a_season_loads_into_the_population_and_is_judged(tmp_path: Path) -> None:
    _write_export(tmp_path / "s2")
    league, season, h, mondays = s2.load(tmp_path / "s2")
    assert (league, season) == ("nba", SEASON)
    first, _ = mondays[0]
    # a is out; his teammates on the board, a himself left out of the population, g on U
    assert first.players == ["b", "c", "d", "e"]
    assert first.absent == ("a",)
    assert s2.leak_check(h, season, mondays) == 2
    res = s2.judge([("nba", season, h, mondays)], 0.0, 0.5, dict.fromkeys(wy.CATEGORIES, 1.0))
    assert res["player_weeks"] == 8
    assert {c["category"] for c in res["categories"]} == set(wy.CATEGORIES)
    with pytest.raises(SystemExit, match="not a judged season"):
        s2._seasons([tmp_path / "s2"], {"nba": {"2023-24"}}, "judged")
