"""The matchup card's backtest scores and judges as declared on #869, and keeps to its seasons: the
fit reads only the tuning seasons, the judgement refuses the locked one."""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ops import closeness_backtest as cb
from ops import matchup as card
from ops import standings
from ops.standings import CATS
from ops.standings_backtest import STATS, beat, cat_values

MEAN = np.array([14.0, 5.5, 3.2, 0.9, 0.6, 1.6, 1.7, 5.2, 11.0, 2.4, 3.0])
SPREAD = np.array([6.0, 2.5, 2.0, 0.4, 0.5, 0.9, 0.8, 2.2, 4.0, 1.5, 1.8])


def _z(line: np.ndarray) -> np.ndarray:
    counts = (line[:, :7] - MEAN[:7]) / SPREAD[:7]
    counts[:, 6] *= -1
    fg = (line[:, 7] - 0.47 * line[:, 8]) / 1.5
    ft = (line[:, 9] - 0.78 * line[:, 10]) / 1.0
    return np.column_stack([counts, fg, ft])


def _season(
    folder: Path, league: str, season: str, *, players: int = 260, weeks: int = 8, seed: int = 1
) -> Path:
    """A fake season the way ``export`` hands it over: each player's true per-game line, a board
    that projects it up to a little noise, a naive line with more, and weekly box scores."""
    rng = np.random.default_rng(seed)
    true = np.clip(MEAN * (1 + 0.6 * rng.standard_normal((players, len(MEAN)))), 0.05, None)
    true[:, 7] = np.minimum(true[:, 7], true[:, 8] * 0.6)
    true[:, 9] = np.minimum(true[:, 9], true[:, 10] * 0.9)
    first = date(2024, 10, 22)
    days = cb.week_days(first, first + timedelta(weeks=weeks - 1))
    folder.mkdir(parents=True)
    (folder / "meta.json").write_text(
        json.dumps({"league": league, "season": season, "weeks": [d.isoformat() for d in days]})
    )
    rows = []
    for d in days:
        monday = d - timedelta(days=d.weekday())
        games = rng.integers(2, 5, players)
        proj = true * (1 + 0.1 * rng.standard_normal(true.shape))
        naive = true * (1 + 0.5 * rng.standard_normal(true.shape))
        df = pd.DataFrame(_z(proj), columns=list(CATS))
        df.insert(0, "player_id", [f"p{i}" for i in range(players)])
        for k, c in enumerate(CATS):
            df[f"recent_{c}"] = _z(proj)[:, k] + 0.3 * rng.standard_normal(players)
        for k, c in enumerate(card.LINE):
            df[c] = proj[:, k]
        df["games_this_week"] = games
        df["injury_group"] = ["out" if u < 0.05 else None for u in rng.uniform(size=players)]
        for k, c in enumerate(cb.NAIVE):
            df[c] = naive[:, k]
        df.to_csv(folder / f"players-{d.isoformat()}.csv", index=False)
        played = np.where(df["injury_group"].eq("out"), 0, games)
        for pid in range(players):
            line = rng.poisson(true[pid] * played[pid])
            line[7] = min(line[7], line[8])
            line[9] = min(line[9], line[10])
            rows.append(
                {
                    "player_id": f"p{pid}",
                    "week": monday,
                    "games": played[pid],
                    **dict(zip(STATS, line, strict=True)),
                }
            )
    pd.DataFrame(rows).to_csv(folder / "weeks.csv", index=False)
    return folder


def _params(**over: object) -> dict[str, object]:
    p = standings.registry()
    p["backtest.standings_leagues"] = 8
    p["backtest.bootstrap"] = 50
    return {**p, **over}


def test_the_weeks_are_the_first_game_day_then_every_monday() -> None:
    days = cb.week_days(date(2024, 10, 22), date(2024, 11, 11))
    assert days == [date(2024, 10, 22), date(2024, 10, 28), date(2024, 11, 4), date(2024, 11, 11)]


def test_the_card_reverses_turnovers_and_spreads_a_percentage_by_its_shots() -> None:
    a = np.array([[100, 40, 20, 8, 5, 12, 14, 40, 80, 20, 25]], dtype=float)
    b = np.array([[90, 45, 20, 8, 5, 10, 18, 40, 90, 20, 25]], dtype=float)
    sigma = np.ones(len(CATS))
    edge, chance, share = card.chances(a, b, np.array([40.0]), np.array([40.0]), sigma)
    assert edge[0, 0] == 10 and edge[0, 6] == 4  # fewer turnovers wins
    assert edge[0, 7] == pytest.approx(40 / 80 - 40 / 90)
    assert chance[0, 2] == pytest.approx(0.5)  # level
    assert share[0, 0] == pytest.approx(0.1)
    unit = card.unit_spread(a, b, np.array([40.0]), np.array([40.0]))
    assert unit[0, 0] == pytest.approx(np.sqrt(80))
    assert unit[0, 7] == pytest.approx(np.sqrt(40 / 80**2 + 40 / 90**2))
    # no games left: the margin is the result
    _, done, _ = card.chances(a, b, np.array([0.0]), np.array([0.0]), sigma)
    assert done[0, 0] == 1 and done[0, 1] == 0 and done[0, 2] == 0.5


def test_the_array_form_agrees_with_the_one_by_one_card() -> None:
    p = standings.registry()
    rows_a = [{**dict(zip(card.LINE, MEAN, strict=True)), "games_this_week": 3}] * 4
    rows_b = [{**dict(zip(card.LINE, MEAN * 1.05, strict=True)), "games_this_week": 4}] * 4
    mine, theirs = card.week_totals(rows_a, CATS), card.week_totals(rows_b, CATS)
    m = card.matchup("nba", CATS, mine, theirs, p)
    a, b = MEAN[None] * 12, MEAN[None] * 1.05 * 16
    _, chance, _ = card.chances(
        a, b, np.array([12.0]), np.array([16.0]), card.sigmas("nba", CATS, p)
    )
    assert [r["chance"] for r in m["cats"]] == pytest.approx(chance[0].tolist(), abs=1e-12)


def test_a_card_that_knows_the_players_beats_the_coin_and_the_naive_manager(
    tmp_path: Path,
) -> None:
    season = cb.load(_season(tmp_path / "s", "nba", "2023-24"))
    res = cb.judge(season, _params())
    assert res["brier_vs_coin"][1] > 0
    assert res["brier_vs_naive"][0] > 0
    assert set(res["won"]) == set(cb.ARMS)
    assert 0 <= res["called_close"]["band"] <= 1


def test_no_target_streams_no_one(tmp_path: Path) -> None:
    season = cb.load(_season(tmp_path / "s", "nba", "2023-24", weeks=2))
    s = cb.simulate(season.weeks[0], _params(), "nba", 1)
    i, j = cb.directed(s.xt.shape[1])
    none = np.zeros((*s.xt.shape[:1], len(i), len(CATS)), dtype=bool)
    base = beat(cat_values(s.xt[:, i]), cat_values(s.xt[:, j])).sum(-1).mean()
    assert cb.replay(s, none) == pytest.approx(base)


def test_the_verdict_applies_the_declared_bar() -> None:
    good = {
        "brier_vs_coin": [0.02, 0.01, 0.03],
        "brier_vs_naive": [0.004, 0.001, 0.006],
        "slope": [1.0, 0.9, 1.1],
        "band_vs_share": [0.0, -0.002, 0.002],
        "band_vs_losing": [0.001, -0.001, 0.003],
        "band_vs_naive": [-0.01, -0.02, -0.005],  # reported, not gated
    }
    assert cb.verdict(good) == []
    bad = {
        **good,
        "brier_vs_naive": [0.001, -0.001, 0.003],
        "band_vs_share": [-0.01, -0.02, -0.004],
    }
    fails = cb.verdict(bad)
    assert len(fails) == 2 and "naive" in fails[0] and "share" in fails[1]
    assert cb.verdict({**good, "slope": [1.3, 1.2, 1.4]})


def test_the_fit_reads_only_the_tuning_seasons(tmp_path: Path) -> None:
    season = cb.load(_season(tmp_path / "s", "nba", "2023-24", weeks=2))
    with pytest.raises(SystemExit, match="not a tuning season"):
        cb.fit([season], _params())


def test_the_fit_picks_spreads_and_a_band_from_their_grids(tmp_path: Path) -> None:
    season = cb.load(_season(tmp_path / "s", "nba", "2021-22", weeks=3))
    res = cb.fit([season], _params())
    assert all(v in cb.SPREADS for v in res["game_spread"].values())
    assert res["closeness"] in cb.BANDS
    for v in res["log_loss"].values():
        assert v["at_pick"] <= v["at_registry"] + 1e-12
        assert v["at_pick"] < v["coin"]


def test_the_held_out_season_is_refused(tmp_path: Path) -> None:
    folder = _season(tmp_path / "s", "nba", "2025-26", weeks=1)
    assert cb.main(["judge", str(folder)]) == 2


def test_the_weighted_slope_is_recovered() -> None:
    rng = np.random.default_rng(3)
    x = rng.normal(size=20000)
    y = (rng.uniform(size=x.size) < 1 / (1 + np.exp(-1.6 * x))).astype(float)
    assert cb.weighted_slope(x, y, np.ones_like(x)) == pytest.approx(1.6, abs=0.08)
