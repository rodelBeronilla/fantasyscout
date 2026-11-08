"""A points league's playoff odds backtest (#891) scores ESPN's way, mirrors the web's odds, and
keeps to its seasons: the fit reads only the tuning seasons, the judgement refuses the locked
one."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from ops import playoff_backtest as pb
from ops import playoffs
from ops import points_backtest as pts
from ops.standings_backtest import PROJECTED, STATS
from tests.test_playoff_backtest import _params
from tests.test_standings_backtest import _season

WEB = Path(__file__).parent.parent / "web" / "src" / "lib" / "fantasy-league.ts"


def _points_season(folder: Path, league: str, season: str, seed: int = 1) -> Path:
    """A fake season with the board's projected per-game line: each player's real per-game line
    over the season, up to a little noise."""
    _season(folder, league, season, weeks=14, seed=seed)
    weeks = pd.read_csv(folder / "weeks.csv")
    line = (
        weeks.groupby("player_id")[list(STATS)]
        .sum()
        .div(weeks.groupby("player_id")["games"].sum(), axis=0)
    )
    rng = np.random.default_rng(seed)
    for f in folder.glob("players-*.csv"):
        df = pd.read_csv(f)
        for c, s in zip(PROJECTED, STATS, strict=True):
            truth = line.loc[df["player_id"], s].to_numpy()
            df[c] = truth * (1 + 0.1 * rng.standard_normal(len(df)))
        df.to_csv(f, index=False)
    return folder


def test_the_scoring_is_espns_default_on_the_web() -> None:
    text = WEB.read_text(encoding="utf-8")
    espn = re.search(r"espn: \{.*?weights: \{([^}]*)\}", text, re.S)
    assert espn
    weights = dict(re.findall(r"(\w+): (-?\d+)", espn.group(1)))
    order = ["points", "rebounds", "assists", "steals", "blocks", "threes", "turnovers"]
    order += ["fgm", "fga", "ftm", "fta"]
    assert [float(weights[k]) for k in order] == pts.ESPN.tolist()


def test_the_odds_are_the_webs_simulation(tmp_path: Path) -> None:
    season = pb.load(_points_season(tmp_path / "s", "nba", "2023-24"))
    p: dict[str, Any] = _params()
    cut = season.cuts[0]
    lg = pts.simulate(cut, p, "nba")
    f = pts.checkpoint(cut, season.weeks, p, "nba", 0.2, 0.3, lg)
    teams = lg.tot.shape[1]
    regular = len(season.weeks) - int(p["playoffs.weeks"]["nba"])
    web = playoffs.simulate_odds(
        [{"fpts": t} for t in lg.tot[0]],
        {"fpts": 0.2 * lg.tot[0].mean()},
        ["fpts"],
        [],
        playoffs.round_robin(teams, regular),
        "matchups",
        int(p["playoffs.teams"]["nba"]),
        int(p["playoffs.simulations"]),
        season_share=0.3,
    )
    assert f.odds[0].tolist() == pytest.approx(web["odds"], abs=1e-12)


def test_the_fit_measures_the_spread_on_tuning_only(tmp_path: Path) -> None:
    folders = [
        _points_season(tmp_path / s, "nba", s, seed=i)
        for i, s in enumerate(("2020-21", "2021-22", "2022-23"), 1)
    ]
    seasons = [pb.load(f) for f in folders]
    res = pts.fit(seasons, _params())
    assert 0 < res["points_spread_share"] < 1
    assert res["points_season_share"] in pts.SHARES
    assert res["on_grid_edge"] == (res["points_season_share"] in (0.0, 0.8))
    assert len(res["independent_check"]) == 6
    with pytest.raises(SystemExit, match="not a tuning season"):
        pts.fit([pb.load(_points_season(tmp_path / "j", "nba", "2023-24"))], _params())


def test_a_board_that_knows_the_players_beats_the_coin(tmp_path: Path) -> None:
    season = pb.load(_points_season(tmp_path / "s", "nba", "2023-24"))
    res = pts.judge(season, _params())
    later = res["checkpoints"][1]
    assert later["points"]["brier_vs_coin"][0] > 0
    assert later["points"]["made_share"] == pytest.approx(6 / 12)
    assert later["weekly"]["z_sd"][0] > 0
    assert pts.verdict({"checkpoints": []}) == []


def test_an_export_without_projections_is_refused(tmp_path: Path) -> None:
    season = pb.load(_season(tmp_path / "s", "nba", "2023-24", weeks=14))
    with pytest.raises(SystemExit, match="no proj_points_pg"):
        pts.simulate(season.cuts[0], _params(), "nba")


def test_the_held_out_season_is_refused(tmp_path: Path) -> None:
    folder = _points_season(tmp_path / "s", "nba", "2025-26")
    assert pts.main(["judge", str(folder)]) == 2
