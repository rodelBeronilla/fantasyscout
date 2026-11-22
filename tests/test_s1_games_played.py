"""S1 (#1079): the rest pattern on back-to-backs, the week's games, and the leak check."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from ops import s1_games_played as s1
from ops import week_yardstick as wy


def history(
    games: list[tuple[str, date, str, str, bool]], days: dict[str, list[date]]
) -> s1.History:
    """Invented players and teams: game rows (season, day, player, team, played) and each team's
    game days."""
    g = pd.DataFrame(games, columns=["season", "game_date", "player_id", "team_id", "played"])
    sched = pd.DataFrame(
        [("2021-22", t, d, "regular") for t, ds in days.items() for d in ds],
        columns=["season", "team_id", "game_date", "game_type"],
    )
    seasons = sorted(set(g["season"]))
    return s1.History(seasons, g, sched, {t: frozenset(ds) for t, ds in days.items()})


D = date(2022, 1, 3)  # a Monday


def day(n: int) -> date:
    return D + timedelta(days=n)


# team A plays a back-to-back on days -6/-5 and -3/-2 before the Monday, and 0/1 and 4 in the week
A_DAYS = [day(-6), day(-5), day(-3), day(-2), day(0), day(1), day(4)]


def a_rows(player: str, sat: set[int]) -> list[tuple[str, date, str, str, bool]]:
    return [("2021-22", d, player, "A", (d - D).days not in sat) for d in A_DAYS]


def test_a_pair_counts_when_he_played_night_one_and_is_sat_when_he_missed_the_second() -> None:
    # p1 sat the second night of the first back-to-back; p2 played everything; p3 missed a first
    # night, so that pair does not count for him
    h = history(a_rows("p1", {-5}) + a_rows("p2", set()) + a_rows("p3", {-3}), {"A": A_DAYS})
    inp = s1.inputs(h, s1.pairs(h), "2021-22", D, decay=1.0)
    assert inp.n == {"p1": 2.0, "p2": 2.0, "p3": 1.0}
    assert inp.sat == {"p1": 1.0, "p2": 0.0, "p3": 0.0}
    assert inp.team == {"p1": "A", "p2": "A", "p3": "A"}


def test_shares_shrink_toward_the_pooled_share() -> None:
    inp = s1.Inputs(n={"a": 4.0, "b": 4.0}, sat={"a": 2.0, "b": 0.0}, team={})
    # pooled: 2 of 8
    assert s1.shares(inp, ["a", "b", "c"], 0.0).tolist() == [0.5, 0.0, 0.25]
    assert s1.shares(inp, ["a", "b"], 4.0).tolist() == [0.375, 0.125]
    assert s1.shares(inp, ["a", "b"], float("inf")).tolist() == [0.25, 0.25]


def test_the_week_takes_the_share_off_each_second_night_and_none_for_a_listed_player() -> None:
    h = history(a_rows("p1", {-5}) + a_rows("p2", set()), {"A": A_DAYS})
    inp = s1.inputs(h, s1.pairs(h), "2021-22", D, decay=1.0)
    # the week has 3 games (days 0, 1, 4); day 1 is a second night
    assert s1.week_games(h, "A", D) == (3, 1)
    players = ["p1", "p2", "p9"]
    scheduled = np.array([3.0, 3.0, 2.0])
    listed = np.array([False, True, False])
    g = s1.predicted_games(h, inp, players, scheduled, listed, D, k=0.0)
    # p1 sat 1 of 2: 3 - 0.5; p2 is listed out: none; p9 has no team: the board's count stands
    assert g.tolist() == [2.5, 0.0, 2.0]
    # a team that does not give the board's count leaves the board's count
    g = s1.predicted_games(h, inp, ["p1"], np.array([2.0]), np.array([False]), D, k=0.0)
    assert g.tolist() == [2.0]


def test_earlier_seasons_weigh_less_by_the_decay() -> None:
    old = [("2020-21", day(-400), "p1", "A", True), ("2020-21", day(-399), "p1", "A", False)]
    days = {"A": [*A_DAYS, day(-400), day(-399)]}
    h = history(old + a_rows("p1", set()), days)
    inp = s1.inputs(h, s1.pairs(h), "2021-22", D, decay=0.5)
    assert inp.n == {"p1": 2.5}
    assert inp.sat == {"p1": 0.5}


def monday(players: list[str], scheduled: list[float]) -> s1.Monday:
    n = len(players)
    return s1.Monday(
        as_of=D,
        players=players,
        scheduled=np.array(scheduled),
        listed=np.zeros(n, dtype=bool),
        line=np.zeros((n, 11)),
        real=np.zeros((n, 11)),
        games=np.zeros(n),
        proj=np.zeros((n, 9)),
    )


def test_the_leak_check_passes_on_inputs_cut_at_the_monday() -> None:
    # p1 plays the Monday and sits the Tuesday: the second night of the week's back-to-back
    h = history(a_rows("p1", {1}), {"A": A_DAYS})
    assert s1.leak_check(h, "2021-22", [monday(["p1"], [3.0])]) == 1


def test_the_leak_check_catches_an_input_that_reads_the_monday(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h = history(a_rows("p1", {1}), {"A": A_DAYS})
    real_inputs = s1.inputs

    def leaky(
        h: s1.History, b2b: pd.DataFrame, season: str, as_of: date, decay: float
    ) -> s1.Inputs:
        # a planted fault: the pairs of the week being predicted are read too
        return real_inputs(h, b2b, season, as_of + timedelta(days=7), decay)

    monkeypatch.setattr(s1, "inputs", leaky)
    with pytest.raises(SystemExit, match="saw the future"):
        s1.leak_check(h, "2021-22", [monday(["p1"], [3.0])])


def category(name: str, diff: float, high: float) -> wy.Category:
    return wy.Category(name, 10 + diff, 10, 0, 0, diff, diff - 0.01, high, 0, 0, 0, 0)


S0 = [{"category": c, "noise": 0.4} for c in wy.CATEGORIES]


def test_the_bar_needs_a_quarter_of_the_noise_in_each_counting_category() -> None:
    # every counting category lower by 0.1 (a quarter of 0.4) with the interval below zero; the
    # percentages unchanged
    cats = [category(c, -0.1 if c in s1.TARGETS else 0.0, -0.05) for c in wy.CATEGORIES]
    rows, fails = s1.apply_bar(cats, S0)
    assert fails == []
    assert [r["target"] for r in rows] == [True] * 7 + [False, False]
    # one short of the bar fails; an interval reaching zero fails
    cats[0] = category("PTS", -0.09, -0.05)
    cats[1] = category("REB", -0.2, 0.01)
    _, fails = s1.apply_bar(cats, S0)
    assert [f.split(":")[0] for f in fails] == ["PTS", "REB"]


def test_no_category_may_get_worse_by_more_than_its_noise() -> None:
    cats = [category(c, -0.1 if c in s1.TARGETS else 0.0, -0.05) for c in wy.CATEGORIES]
    cats[7] = category("FG%", 0.41, 0.5)
    _, fails = s1.apply_bar(cats, S0)
    assert fails == ["FG%: worse by +0.4100, more than its noise 0.4000"]


def test_the_placebo_gets_all_of_a_gain_that_is_only_a_flat_discount() -> None:
    rng = np.random.default_rng(3)
    weeks = []
    for n in range(8):
        line = np.abs(rng.normal(5, 2, (30, 11)))
        scheduled = rng.integers(2, 5, 30).astype(float)
        played = np.maximum(scheduled - rng.integers(0, 2, 30), 0)
        real = line * played[:, None] + rng.normal(0, 1, line.shape)
        m = s1.Monday(
            as_of=D + timedelta(days=7 * n),
            players=[f"p{i}" for i in range(30)],
            scheduled=scheduled,
            listed=np.zeros(30, dtype=bool),
            line=line,
            real=real,
            games=played,
            proj=wy.category_weeks(line, scheduled, real),
        )
        weeks.append((m, scheduled * 0.9))  # a "study" that is a flat tenth off every game
    res = s1.placebo(weeks)
    assert res["discount_share"] == pytest.approx(0.1)
    for c in res["categories"]:
        assert c["share_of_gain"] == pytest.approx(1.0)
        assert c["study_minus_placebo"] == pytest.approx(0.0, abs=1e-9)
