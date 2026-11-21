"""S4's study (#1082): every input as of the Monday, the shot-diet arithmetic, S0's weeks read with
each player's id, and the fit and judgement kept to their seasons."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pytest

from ops import shot_diet as sd
from ops import week_yardstick as wy
from tests.test_closeness_backtest import _season


def _shots(
    players: int, first: date, days: int, seasons: tuple[str, ...], seed: int = 0
) -> pd.DataFrame:
    """Invented shots: each player shoots every other day of each season, from the basic zones,
    with his own accuracy by zone."""
    rng = np.random.default_rng(seed)
    acc = np.clip(rng.normal(0.45, 0.1, (players, len(sd.ZONES))), 0.05, 0.9)
    diet = rng.dirichlet(np.ones(len(sd.ZONES)), players)
    rows = []
    for back, season in enumerate(seasons):
        start = first - timedelta(days=365 * back)
        for d in range(0, days, 2):
            day = start + timedelta(days=d)
            for p in range(players):
                att = rng.multinomial(12, diet[p])
                for z in np.flatnonzero(att):
                    rows.append(
                        {
                            "season": season,
                            "player_id": f"p{p}",
                            "game_date": day,
                            "zone": sd.ZONES[z],
                            "is_three": bool(sd.THREE_ZONES[z]),
                            "fga": int(att[z]),
                            "fgm": int(rng.binomial(att[z], acc[p, z])),
                            "z": int(z),
                        }
                    )
    return pd.DataFrame(rows)


def test_the_long_run_is_the_season_and_the_two_before() -> None:
    assert sd.seasons_back("2023-24") == ["2023-24", "2022-23", "2021-22"]
    assert sd.seasons_back("1999-00") == ["1999-00", "1998-99", "1997-98"]
    assert sd.seasons_back("2024") == ["2024", "2023", "2022"]


def test_every_input_is_as_of_the_monday() -> None:
    shots = _shots(6, date(2023, 10, 24), 60, ("2023-24", "2022-23", "2021-22", "2020-21"))
    monday = date(2023, 11, 13)
    inp = sd.check_point_in_time(shots, "2023-24", monday)
    assert inp.newest is not None and inp.newest < monday
    # there are shots on the Monday and after it, and none of them is read
    assert shots.loc[shots["game_date"] == monday, "fga"].sum() > 0
    before = shots[(shots["game_date"] < monday) & shots["season"].isin(sd.seasons_back("2023-24"))]
    assert inp.att.sum() == before["fga"].sum()
    # a season outside the long run is not read either
    assert "2020-21" in set(shots["season"])
    # an input that read a later shot is caught
    leaky = sd.monday_inputs(shots, "2023-24", monday + timedelta(days=2))
    assert leaky.att.sum() > inp.att.sum()


def test_a_leak_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    shots = _shots(4, date(2023, 10, 24), 40, ("2023-24",))
    real = sd.monday_inputs

    def peeks(s: pd.DataFrame, season: str, as_of: date) -> sd.Inputs:
        return real(s, season, as_of + timedelta(days=3))

    monkeypatch.setattr(sd, "monday_inputs", peeks)
    with pytest.raises(AssertionError, match="saw a shot"):
        sd.check_point_in_time(shots, "2023-24", date(2023, 11, 13))


def test_the_rate_is_the_recent_diet_times_the_shrunk_long_run_accuracy() -> None:
    # one player: 10 at the rim (6 made) and 10 threes (4 made) over his games; league 60% and 30%
    made = np.zeros((1, 7))
    att = np.zeros((1, 7))
    made[0, 0], att[0, 0] = 6, 10
    made[0, 5], att[0, 5] = 4, 10
    recent = np.zeros((1, 7))
    recent[0, 0], recent[0, 5] = 3, 1  # lately three in four at the rim
    inp = sd.Inputs(
        ids={"a": 0},
        made=made,
        att=att,
        recent={10: recent, 20: recent},
        league_made=np.array([60, 0, 0, 0, 0, 30, 0.0]),
        league_att=np.array([100, 0, 0, 0, 0, 100, 0.0]),
        newest=date(2024, 1, 1),
    )
    line = np.zeros((2, 11))
    line[:, sd.FGA_PG] = 12.0
    line[:, sd.FGM_PG] = 6.0
    line[:, sd.THREES_PG] = 1.5
    fg, threes, has = sd.predict(inp, ["a", "nobody"], line, "two", 10, 10)
    rim = (6 + 10 * 0.6) / (10 + 10)  # 0.6
    three = (4 + 10 * 0.3) / (10 + 10)  # 0.35
    assert fg[0] == pytest.approx(0.75 * rim + 0.25 * three)
    assert threes[0] == pytest.approx(12.0 * 0.25 * three)
    # nothing in the shots: the projection's own line
    assert has.tolist() == [True, False]
    assert fg[1] == pytest.approx(0.5)
    assert threes[1] == pytest.approx(1.5)


def _folders(tmp_path: Path) -> tuple[list[Path], list[Path], pd.DataFrame]:
    tuning = [
        _season(tmp_path / s, "nba", s, players=150, weeks=4, seed=i)
        for i, s in enumerate(("2020-21", "2021-22"))
    ]
    judged = [_season(tmp_path / "2023-24", "nba", "2023-24", players=150, weeks=4, seed=5)]
    first = date(2024, 10, 22)
    shots = _shots(
        150, first - timedelta(days=30), 60, ("2023-24", "2022-23", "2021-22", "2020-21")
    )
    # the fake seasons all run from 2024-10-22: label the shots so each season's window has some
    shots = pd.concat(
        [shots.assign(season=s) for s in ("2020-21", "2021-22", "2023-24")], ignore_index=True
    ).drop_duplicates(["season", "player_id", "game_date", "zone", "is_three"])
    return tuning, judged, shots


def test_the_weeks_are_s0s_with_each_players_id(tmp_path: Path) -> None:
    tuning, _, _ = _folders(tmp_path)
    league, season, mondays = sd.load_weeks(tuning[0])
    _, _, s0 = wy.load(tuning[0])
    assert (league, season) == ("nba", "2020-21")
    for m, w in zip(mondays, s0, strict=True):
        assert len(m.ids) == len(w.real) == wy.POOL
        assert np.array_equal(m.base.proj, w.proj)


def test_fit_chooses_on_the_tuning_seasons_and_judge_scores_study_minus_projection(
    tmp_path: Path,
) -> None:
    tuning, judged, shots = _folders(tmp_path)
    seasons = sd.read_seasons(tuning, shots, "nba")
    res = sd.fit(seasons)
    assert len(res["grid"]) == len(sd.SCHEMES) * len(sd.SHRINK) * len(sd.RECENT_GAMES)
    for c in sd.TARGETS:
        best = min(r[c] for r in res["grid"])
        point = res["chosen"][c]
        assert next(r[c] for r in res["grid"] if all(r[k] == v for k, v in point.items())) == best
    base = [w for f in tuning for w in wy.load(f)[2]]
    out = sd.judge(base, sd.read_seasons(judged, shots, "nba"), res["chosen"])
    by = {r["category"]: r for r in out["categories"]}
    # the seven other categories are the projection's: no difference at all
    for c in ("PTS", "REB", "AST", "STL", "BLK", "TO", "FT%"):
        assert by[c]["diff"] == 0.0 and by[c]["passes"]
    for c in sd.TARGETS:
        r = by[c]
        assert r["diff"] == pytest.approx(r["rmse_study"] - r["rmse_projection"])
        assert r["passes"] == (r["diff"] <= r["bar"] and r["diff_high"] < 0)
    assert out["passes"] == all(r["passes"] for r in out["categories"])


def test_judge_refuses_without_a_choice_and_the_fit_refuses_other_seasons(tmp_path: Path) -> None:
    tuning, judged, shots = _folders(tmp_path)
    folder = tmp_path / "shots"
    folder.mkdir()
    shots.drop(columns="z").to_csv(folder / "shots.csv.gz", index=False)
    pd.DataFrame({"season": ["2020-21"]}).to_csv(folder / "coverage.csv", index=False)
    (folder / "meta.json").write_text(json.dumps({"league": "nba", "seasons": ["2020-21"]}))
    with pytest.raises(SystemExit, match="not a tuning season"):
        sd.main(["fit", str(judged[0]), "--shots", str(folder), "--out", str(tmp_path / "f.json")])
    args = ["judge", "--shots", str(folder), "--tuning", str(tuning[0]), "--judged", str(judged[0])]
    assert sd.main([*args, "--out", str(tmp_path / "j.json")]) == 2
    locked = _season(tmp_path / "locked", "nba", "2025-26", players=10, weeks=1)
    with pytest.raises(SystemExit, match="locked"):
        sd.main(["fit", str(locked), "--shots", str(folder), "--out", str(tmp_path / "f.json")])


def test_export_reads_the_regular_season_shots_by_zone(tmp_path: Path) -> None:
    db = tmp_path / "full.duckdb"
    with duckdb.connect(str(db)) as con:
        con.execute("create schema gold")
        shot = pd.DataFrame(
            [
                (
                    "nba",
                    "2023-24",
                    "0022300001",
                    date(2023, 10, 24),
                    "Restricted Area",
                    False,
                    True,
                ),
                (
                    "nba",
                    "2023-24",
                    "0022300001",
                    date(2023, 10, 24),
                    "Restricted Area",
                    False,
                    False,
                ),
                ("nba", "2023-24", "0022300001", date(2023, 10, 24), "Left Corner 3", True, True),
                ("nba", "2023-24", "0042300001", date(2024, 4, 20), "Restricted Area", False, True),
                ("wnba", "2024", "1022400001", date(2024, 5, 14), "Mid-Range", False, True),
            ],
            columns=[
                "league",
                "season",
                "game_id",
                "game_date",
                "shot_zone_basic",
                "is_three",
                "made",
            ],
        ).assign(player_id="1")
        con.register("shot", shot)
        con.execute("create table gold.fct_shot as select *, made as shot_made from shot")
        con.execute(
            "create table gold.fct_player_game as select * from (values"
            " ('nba', '2023-24', '0022300001', '1', 3, true)"
            ") as t(league, season, game_id, player_id, field_goals_attempted, played)"
        )
    sd.export(db, "nba", tmp_path / "out")
    league, shots, coverage = sd.load_shots(tmp_path / "out")
    assert league == "nba"
    # the playoff game and the other league are left out
    assert sorted(zip(shots["zone"], shots["fga"], shots["fgm"], strict=True)) == [
        ("Left Corner 3", 1, 1),
        ("Restricted Area", 2, 1),
    ]
    assert sorted(shots["z"].tolist()) == [0, 3]
    assert coverage[["box_fga", "shot_fga"]].iloc[0].tolist() == [3, 3]
