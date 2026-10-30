"""The point-in-time replay of the board (notebooks/replay.py) on small synthetic frames."""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "notebooks"))
import replay

# A tiny league: a pool of 4 (2 teams x 2 spots), replacement level the next 2 players.
TINY = replay.Settings(
    league="nba",
    teams=2,
    roster_spots=2,
    prior_games=0.0,
    minutes_recency=(1.0, 0.25, 0.08),
    durability_games=10.0,
    recency=(1.0, 0.25, 0.08),
    typical_share=0.8,
    team_change=0.25,
    recent_minutes=0.5,
)
SEASONS = {"2023-24": pd.Timestamp("2023-10-24"), "2024-25": pd.Timestamp("2024-10-22")}


def row(season: str, game: int, player: str, team: str, minutes: float, scale: float = 1.0) -> dict:
    """One box-score row; production scales with minutes (and ``scale``)."""
    start = SEASONS[season]
    m = minutes * scale / 30
    return {
        "league": "nba",
        "season": season,
        "game_id": f"002{season[2:4]}{game:05d}",
        "game_date": start + pd.Timedelta(days=2 * game),
        "player_id": player,
        "team_id": team,
        "position": "G" if minutes >= 30 else None,
        "minutes": minutes if minutes > 0 else None,
        "played": True if minutes > 0 else None,
        "points": round(15 * m),
        "rebounds_total": round(6 * m),
        "assists": round(4 * m),
        "steals": round(1 * m),
        "blocks": round(1 * m),
        "three_pointers_made": round(2 * m),
        "three_pointers_attempted": round(5 * m),
        "turnovers": round(2 * m),
        "field_goals_made": round(6 * m),
        "field_goals_attempted": round(13 * m),
        "free_throws_made": round(2 * m),
        "free_throws_attempted": round(3 * m),
    }


def league(games_per_season: int = 10) -> list[dict]:
    """Eight players over two seasons on two teams, minutes 10 to 38."""
    rows = []
    for season in SEASONS:
        for g in range(1, games_per_season + 1):
            for i in range(8):
                team = "T1" if i % 2 == 0 else "T2"
                rows.append(row(season, g, f"p{i}", team, 10 + 4 * i, scale=1 + 0.1 * i))
    return rows


def frame(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=list(replay.GAME_COLUMNS))


def roster(*pairs: tuple[str, str]) -> pd.DataFrame:
    return pd.DataFrame(pairs, columns=["player_id", "team_id"])


ALL = roster(*[(f"p{i}", "T1" if i % 2 == 0 else "T2") for i in range(8)])


def test_settings_follow_the_dbt_project() -> None:
    s = replay.load_settings()
    assert s["nba"].pool_size == 156 and s["wnba"].pool_size == 100
    assert s["nba"].prior_games == 3 and s["wnba"].prior_games == 5
    assert s["wnba"].minutes_recency == (1.0, 0.06, 0.02)
    assert s["nba"].recency == (1.0, 0.25, 0.08)
    assert s["nba"].recent_minutes == 0.5 and s["nba"].team_change == 0.25


def test_a_game_on_or_after_the_checkpoint_changes_nothing() -> None:
    rows = league()
    as_of = SEASONS["2024-25"] + pd.Timedelta(days=12)  # five games in; game 6 is on this day
    base = replay.Replay(frame(rows), TINY).board(
        as_of, ALL, in_season=True, complete_seasons=["2023-24"]
    )
    later = [
        *rows,
        row("2024-25", 6, "p0", "T1", 48, scale=5.0),
        row("2024-25", 40, "p1", "T2", 48, scale=5.0),
    ]
    after = replay.Replay(frame(later), TINY).board(
        as_of, ALL, in_season=True, complete_seasons=["2023-24"]
    )
    cols = ["proj_minutes_pg", "proj_points_pg", "games_share", "value_per_game", "value_total"]
    pd.testing.assert_frame_equal(base[cols], after[cols])


def test_production_is_weighted_by_minutes_and_recency() -> None:
    # p9: 10 games of 20 points last season and 10 games of 10 points this season, 30 minutes each
    rows = league()
    for g in range(1, 11):
        r = row("2023-24", g, "p9", "T1", 30)
        r["points"] = 20
        rows.append(r)
        r = row("2024-25", g, "p9", "T1", 30)
        r["points"] = 10
        rows.append(r)
    as_of = SEASONS["2024-25"] + pd.Timedelta(days=30)
    p = replay.Replay(frame(rows), TINY).project(as_of, roster(("p9", "T1")), in_season=False)
    # (1.0 x 10 x 10 + 0.25 x 10 x 20) / (1.0 x 10 x 30 + 0.25 x 10 x 30) a minute, x 30 minutes
    assert p.loc["p9", "proj_points_pg"] == pytest.approx(150 / 375 * 30)
    assert p.loc["p9", "proj_minutes_pg"] == pytest.approx(30)


def test_the_prior_pulls_a_short_sample_toward_replacement_level() -> None:
    rows = league()
    for g in range(1, 3):  # two games of a big line this season
        r = row("2024-25", g, "rookie", "T1", 40)
        r["points"] = 40
        rows.append(r)
    as_of = SEASONS["2024-25"] + pd.Timedelta(days=30)
    settings = replace(TINY, prior_games=3.0)
    rp = replay.Replay(frame(rows), settings)
    p = rp.project(as_of, roster(("rookie", "T1")), in_season=False, complete_seasons=["2023-24"])
    # replacement line: ranks 5 and 6 by total minutes in 2023-24 are p3 and p2 (26 and 22 minutes)
    ref = frame(rows)
    ref = ref[(ref["season"] == "2023-24") & ref["player_id"].isin(["p3", "p2"])]
    prior_minutes = ref.groupby("player_id")["minutes"].mean().mean()
    prior_points = ref.groupby("player_id")["points"].mean().mean()
    minutes = (2 * 40 + 3 * prior_minutes) / (2 + 3)
    rate = (2 * 40 + 3 * prior_points) / (2 * 40 + 3 * prior_minutes)
    assert p.loc["rookie", "proj_minutes_pg"] == pytest.approx(minutes)
    assert p.loc["rookie", "proj_points_pg"] == pytest.approx(rate * minutes)
    assert p.loc["rookie", "w_prior"] == pytest.approx(
        3 * prior_minutes / (2 * 40 + 3 * prior_minutes)
    )


def test_in_season_minutes_blend_the_last_five_games() -> None:
    rows = league()
    for g in range(1, 11):
        rows.append(row("2023-24", g, "p9", "T1", 20))
    for g in range(1, 7):  # this season: a role change to 36 minutes
        rows.append(row("2024-25", g, "p9", "T1", 36 if g > 1 else 20))
    as_of = SEASONS["2024-25"] + pd.Timedelta(days=20)
    rp = replay.Replay(frame(rows), TINY)
    who = roster(("p9", "T1"))
    off = rp.project(as_of, who, in_season=False)
    on = rp.project(as_of, who, in_season=True)
    # season-weighted: (1.0 x (20 + 5 x 36) + 0.25 x 10 x 20) / (1.0 x 6 + 0.25 x 10)
    base = (20 + 5 * 36 + 0.25 * 200) / (6 + 2.5)
    assert off.loc["p9", "proj_minutes_pg"] == pytest.approx(base)
    assert on.loc["p9", "proj_minutes_pg"] == pytest.approx(0.5 * base + 0.5 * 36)
    # four games for the current team are not enough to blend
    early = rp.project(SEASONS["2024-25"] + pd.Timedelta(days=9), who, in_season=True)
    assert early.loc["p9", "proj_minutes_pg"] == pytest.approx(
        early.loc["p9", "proj_minutes_season_pg"]
    )


def test_a_season_on_another_team_counts_less_for_minutes() -> None:
    rows = league()
    for g in range(1, 11):
        rows.append(row("2023-24", g, "p9", "T2", 36))
        rows.append(row("2024-25", g, "p9", "T1", 20))
    as_of = SEASONS["2024-25"] + pd.Timedelta(days=30)
    p = replay.Replay(frame(rows), TINY).project(as_of, roster(("p9", "T1")), in_season=False)
    assert p.loc["p9", "proj_minutes_pg"] == pytest.approx(
        (10 * 20 + 0.25 * 0.25 * 10 * 36) / (10 + 0.25 * 0.25 * 10)
    )


def test_games_share_regresses_toward_a_typical_share() -> None:
    rows = league()
    for g in range(1, 6):  # half of the team's ten games last season
        rows.append(row("2023-24", g, "p9", "T1", 30))
    as_of = SEASONS["2024-25"]  # before the second season
    p = replay.Replay(frame(rows), TINY).project(as_of, roster(("p9", "T1")), in_season=False)
    assert p.loc["p9", "games_share"] == pytest.approx((5 + 10 * 0.8) / (10 + 10))


def test_value_is_zero_at_replacement_level() -> None:
    rows = league()
    as_of = SEASONS["2024-25"] + pd.Timedelta(days=30)
    b = replay.Replay(frame(rows), TINY).board(
        as_of, ALL, in_season=True, complete_seasons=["2023-24"]
    )
    band = b[(b["rank"] > 4) & (b["rank"] <= 6)]
    assert band["value_per_game"].mean() == pytest.approx(0, abs=1e-9)
    assert b["in_pool"].sum() == 4
    assert b.sort_values("rank")["value_per_game"].is_monotonic_decreasing


def test_realised_counts_missed_games_as_zero() -> None:
    rows = league()
    rp = replay.Replay(frame(rows), TINY)
    start = SEASONS["2024-25"] + pd.Timedelta(days=11)
    real = rp.realised("2024-25", start, roster(*ALL.itertuples(index=False), ("gone", "T1")))
    assert real.loc["gone", "value_total"] == 0 and np.isnan(real.loc["gone", "value_pg"])
    assert real.loc["p7", "share"] == 1
    assert real.loc["p7", "value_total"] == pytest.approx(real.loc["p7", "value_pg"])


def test_checkpoints_skip_preseason_without_an_earlier_season() -> None:
    rp = replay.Replay(frame(league()), TINY)
    assert [label for label, _ in rp.checkpoints("2023-24")] == [
        "a tenth in",
        "a quarter in",
        "half way",
    ]
    assert rp.checkpoints("2024-25")[0][0] == "preseason"


def test_metrics() -> None:
    assert list(replay.average_rank(np.array([3.0, 1.0, 3.0, 2.0]))) == [3.5, 1.0, 3.5, 2.0]
    x = np.arange(10.0)
    assert replay.spearman(x, x**3) == pytest.approx(1.0)
    assert replay.top_hits(x, x, 3) == 1.0
    assert replay.top_hits(x, -x, 3) == 0.0
    assert replay.top_hits(x, np.where(x > 7, np.nan, x), 2) == 0.0
    assert replay.capture(x, x, 3) == 1.0
