"""S3's study (#1081): every input as of the Monday, the chances-times-conversion arithmetic, and
the fit and judgement kept to their seasons. Invented players and games only."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pytest

from ops import s3_opportunity as s3
from ops import week_yardstick as wy
from tests.test_closeness_backtest import _season


def _games(
    players: int, first: date, days: int, seasons: tuple[str, ...], seed: int = 0
) -> pd.DataFrame:
    """Invented games: each player plays every other day, with his own chances per game and his
    own conversion of each; a few tracking lines are missing."""
    rng = np.random.default_rng(seed)
    chances = rng.uniform(1, 12, (players, len(s3.PAIRS)))
    conv = rng.uniform(0.1, 0.7, (players, len(s3.PAIRS)))
    rows = []
    for back, season in enumerate(seasons):
        start = first - timedelta(days=365 * back)
        for d in range(0, days, 2):
            day = start + timedelta(days=d)
            for p in range(players):
                row: dict[str, object] = {"season": season, "game_date": day, "player_id": f"p{p}"}
                for j, (made_col, chance_col) in enumerate(s3.PAIRS.values()):
                    c = int(rng.poisson(chances[p, j]))
                    row[chance_col] = float(c) if rng.uniform() > 0.03 else np.nan
                    row[made_col] = int(rng.binomial(c, conv[p, j]))
                rows.append(row)
    return pd.DataFrame(rows)


def test_every_input_is_as_of_the_monday() -> None:
    games = _games(6, date(2023, 10, 24), 60, ("2023-24", "2022-23", "2021-22", "2020-21"))
    monday = date(2023, 11, 13)
    inp, changed = s3.check_point_in_time(games, "2023-24", monday)
    assert inp.newest is not None and inp.newest < monday
    assert changed
    # there are games on the Monday and after it, and none of them is read
    assert (games["game_date"] == monday).any()
    window = games["season"].isin(["2023-24", "2022-23", "2021-22"])
    before = games[(games["game_date"] < monday) & window & games["rebound_chances"].notna()]
    assert inp.by_category["REB"].long_chances.sum() == before["rebound_chances"].sum()
    assert inp.by_category["REB"].long_made.sum() == before["reb"].sum()
    # a season outside the long run is not read either
    assert "2020-21" in set(games["season"])
    # an input that read a later game is caught by its sums
    leaky = s3.monday_inputs(games, "2023-24", monday + timedelta(days=2))
    assert leaky.by_category["AST"].long_chances.sum() > inp.by_category["AST"].long_chances.sum()


def test_a_leak_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    games = _games(4, date(2023, 10, 24), 40, ("2023-24",))
    real = s3.monday_inputs

    def peeks(g: pd.DataFrame, season: str, cut: date) -> s3.Inputs:
        return real(g, season, cut + timedelta(days=1))

    monkeypatch.setattr(s3, "monday_inputs", peeks)
    with pytest.raises(AssertionError, match="saw a game"):
        s3.check_point_in_time(games, "2023-24", date(2023, 11, 13))


def test_a_blind_check_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    """The positive control: a check whose inputs do not move when the last game before the
    Monday is rewritten would pass anything, so it fails instead."""
    games = _games(4, date(2023, 10, 24), 40, ("2023-24",))
    fixed = s3.monday_inputs(games, "2023-24", date(2023, 11, 13))

    def blind(g: pd.DataFrame, season: str, cut: date) -> s3.Inputs:
        return fixed

    monkeypatch.setattr(s3, "monday_inputs", blind)
    with pytest.raises(AssertionError, match="blind"):
        s3.check_point_in_time(games, "2023-24", date(2023, 11, 13))


def test_the_line_is_recent_chances_times_the_shrunk_long_run_conversion() -> None:
    # one player, rebounds: six games, 10 chances each and 4 rebounds in all but the last two,
    # where he had 20 chances and 6 rebounds; the league converts at a half
    days = [date(2024, 1, d) for d in range(1, 7)]
    rows = []
    for i, d in enumerate(days):
        recent = i >= 4
        rows.append(
            {
                "season": "2023-24",
                "game_date": d,
                "player_id": "a",
                "rebound_chances": 20.0 if recent else 10.0,
                "reb": 6 if recent else 4,
                "potential_assists": np.nan,
                "ast": 1,
                "deflections": 2.0,
                "stl": 1,
                "contested_shots": 0.0,
                "blk": 0,
            }
        )
    # a second player puts the league's conversion at a half over all the games
    for d in days:
        rows.append(
            {**rows[0], "game_date": d, "player_id": "b", "rebound_chances": 10.0, "reb": 7}
        )
    g = pd.DataFrame(rows)
    inp = s3.monday_inputs(g, "2023-24", date(2024, 1, 8))
    chances, made = 4 * 10 + 2 * 20, 4 * 4 + 2 * 6  # 80, 28
    league = (made + 6 * 7) / (chances + 60)  # 70 / 140
    assert league == pytest.approx(0.5)
    rate, control, has = s3.predict(inp, ["a", "nobody"], "REB", 5, 20)
    recent_chances = (3 * 10 + 2 * 20) / 5  # his last five games
    assert rate[0] == pytest.approx(recent_chances * (made + 20 * league) / (chances + 20))
    assert control[0] == pytest.approx((3 * 4 + 2 * 6) / 5)
    assert has.tolist() == [True, False]
    # no tracking line for a category: nothing to go on
    assert not s3.predict(inp, ["a"], "AST", 5, 0)[2].any()
    # a player with no chance ever converts at the league's rate when k is 0
    blk, _, has_blk = s3.predict(inp, ["a"], "BLK", 5, 0)
    assert has_blk.all() and blk[0] == 0.0
    # a Monday with nobody in the population predicts nothing
    assert [len(x) for x in s3.predict(inp, [], "REB", 5, 0)] == [0, 0, 0]


def _folders(tmp_path: Path) -> tuple[list[Path], list[Path], pd.DataFrame]:
    tuning = [
        _season(tmp_path / s, "nba", s, players=150, weeks=4, seed=i)
        for i, s in enumerate(("2020-21", "2021-22"))
    ]
    judged = [_season(tmp_path / "2023-24", "nba", "2023-24", players=150, weeks=4, seed=5)]
    first = date(2024, 10, 22)
    games = _games(150, first - timedelta(days=40), 40, ("x",))
    # the fake seasons all run from 2024-10-22: label the games so each season's window has some
    games = pd.concat(
        [games.assign(season=s) for s in ("2020-21", "2021-22", "2023-24")], ignore_index=True
    )
    return tuning, judged, games


def test_fit_chooses_on_the_tuning_seasons_and_judge_scores_study_minus_projection(
    tmp_path: Path,
) -> None:
    tuning, judged, games = _folders(tmp_path)
    seasons = s3.read_seasons(tuning, games)
    assert all(s.controls == len(s.mondays) for s in seasons)
    res = s3.fit(seasons)
    assert len(res["grid"]) == len(s3.RECENT_GAMES) * len(s3.SHRINK)
    for c in s3.TARGETS:
        best = min(r[c] for r in res["grid"])
        point = res["chosen"][c]
        assert (
            next(r[c] for r in res["grid"] if r["n"] == point["n"] and r["k"] == point["k"]) == best
        )
    base = [w for f in tuning for w in wy.load(f)[2]]
    out = s3.judge(base, s3.read_seasons(judged, games), res["chosen"], games)
    by = {r["category"]: r for r in out["categories"]}
    # the five other categories are the projection's: no difference at all
    for c in ("PTS", "3PM", "TO", "FG%", "FT%"):
        assert by[c]["diff"] == 0.0 and by[c]["passes"]
    for c in s3.TARGETS:
        r = by[c]
        assert r["diff"] == pytest.approx(r["rmse_study"] - r["rmse_projection"])
        assert r["passes"] == (r["diff"] <= r["bar"] and r["diff_high"] < 0)
    assert out["passes"] == all(r["passes"] for r in out["categories"])
    extra = out["reported_only"]
    assert set(extra["recency_control_minus_projection"]) == set(s3.TARGETS)
    assert set(extra["tracking_coverage"]["2023-24"]) == set(s3.TARGETS)


def _chances_folder(folder: Path, games: pd.DataFrame, seasons: list[str]) -> Path:
    folder.mkdir()
    games.to_csv(folder / "games.csv.gz", index=False)
    pd.DataFrame({"season": seasons}).to_csv(folder / "coverage.csv", index=False)
    (folder / "meta.json").write_text(json.dumps({"league": "nba", "seasons": seasons}))
    return folder


def test_judge_refuses_without_a_choice_and_each_step_refuses_other_seasons(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tuning, judged, games = _folders(tmp_path)
    tuning_games = games[games["season"] != "2023-24"]
    folder = _chances_folder(tmp_path / "chances", tuning_games, ["2020-21", "2021-22"])
    with pytest.raises(SystemExit, match="not a tuning season"):
        s3.main(["fit", str(judged[0]), "--chances", str(folder), "--out", str(tmp_path / "f")])
    # the fit refuses chances that hold a judged season, before reading them
    mixed = _chances_folder(tmp_path / "mixed", games, ["2021-22", "2023-24"])
    with pytest.raises(SystemExit, match="may not read"):
        s3.main(["fit", str(tuning[0]), "--chances", str(mixed), "--out", str(tmp_path / "f")])
    monkeypatch.setattr(s3, "CHOSEN", {})
    args = [
        "judge",
        "--chances",
        str(mixed),
        "--tuning",
        str(tuning[0]),
        "--judged",
        str(judged[0]),
    ]
    assert s3.main([*args, "--out", str(tmp_path / "j.json")]) == 2
    locked = _season(tmp_path / "locked", "nba", "2025-26", players=10, weeks=1)
    with pytest.raises(SystemExit, match="locked"):
        s3.main(["fit", str(locked), "--chances", str(folder), "--out", str(tmp_path / "f")])
    wnba = _season(tmp_path / "wnba", "wnba", "2022", players=10, weeks=1)
    with pytest.raises(SystemExit, match="NBA only"):
        s3.main(["fit", str(wnba), "--chances", str(folder), "--out", str(tmp_path / "f")])


def test_export_reads_the_regular_season_games_played_with_their_chances(tmp_path: Path) -> None:
    db = tmp_path / "full.duckdb"
    with duckdb.connect(str(db)) as con:
        con.execute("create schema gold")
        con.execute(
            "create table gold.fct_player_game as select * from (values"
            " ('nba', '2022-23', '0022200001', date '2022-10-18', '1', true, 10, 5, 2, 1),"
            " ('nba', '2022-23', '0022200002', date '2022-10-20', '1', true, 8, 3, 1, 0),"
            " ('nba', '2022-23', '0022200003', date '2022-10-22', '1', false, 0, 0, 0, 0),"
            " ('nba', '2022-23', '0042200001', date '2023-04-20', '1', true, 9, 9, 9, 9),"
            " ('nba', '2021-22', '0022100001', date '2021-10-20', '1', true, 7, 7, 7, 7)"
            ") as t(league, season, game_id, game_date, player_id, played, rebounds_total,"
            " assists, steals, blocks)"
        )
        con.execute(
            "create table gold.fct_player_tracking as select * from (values"
            " ('nba', '0022200001', '1', 18, 9, 3, 7, 10, 5)"
            ") as t(league, game_id, player_id, rebound_chances, potential_assists, deflections,"
            " contested_shots, tracking_rebounds, tracking_assists)"
        )
    s3.export(db, "nba", ["2022-23"], tmp_path / "out")
    league, games, coverage = s3.load_games(tmp_path / "out")
    assert league == "nba"
    # the game not played, the playoff game and the season not asked for are left out; the game
    # without a tracking line keeps its box score
    assert games[["reb", "rebound_chances"]].fillna(-1).values.tolist() == [[10, 18], [8, -1]]
    row = coverage.iloc[0]
    assert (row["played"], row["tracked"], row["box_reb"], row["tracking_reb"]) == (2, 1, 10, 10)
    with pytest.raises(SystemExit, match="locked"):
        s3.export(db, "nba", ["2025-26"], tmp_path / "out2")
    with pytest.raises(SystemExit, match="NBA only"):
        s3.export(db, "wnba", ["2024"], tmp_path / "out3")


def test_the_frozen_choice_is_a_grid_point_for_each_target() -> None:
    if not s3.CHOSEN:
        pytest.skip("not fitted yet")
    assert set(s3.CHOSEN) == set(s3.TARGETS)
    assert all(p in s3.grid() for p in s3.CHOSEN.values())
