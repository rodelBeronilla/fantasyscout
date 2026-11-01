"""The fixture refresh keeps the code's shape with the live build's values (#245)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from export import fixture
from export.encode import to_json

ROOT = Path(__file__).resolve().parent.parent
DBT_DB = ROOT / "dbt" / "fantasyscout.duckdb"


def test_keeps_only_what_the_pages_read() -> None:
    assert fixture.keeps("board/nba.json")
    assert fixture.keeps("players/wnba/1.json") and not fixture.keeps("players/nba/1.json")
    assert fixture.keeps("dim_team.parquet")
    assert fixture.keeps(f"fct_shot/{fixture.LEAGUE}-{fixture.SEASON}.parquet")
    assert not fixture.keeps("fct_shot/nba-2025-26.parquet")
    assert not fixture.keeps(f"fct_event/{fixture.LEAGUE}-{fixture.SEASON}.parquet")
    assert not fixture.keeps("mart_board.csv")


def test_trim_cuts_root_tables_to_the_fixture_league_and_season() -> None:
    rows = [
        {"league": "nba", "season": "2025-26", "x": 1},
        {"league": fixture.LEAGUE, "season": fixture.SEASON, "x": 2},
        {"league": fixture.LEAGUE, "season": "2025", "x": 3},
    ]
    assert json.loads(fixture.trim("dim_game.json", to_json(rows))) == [rows[1]]
    # A table without a league column, and anything under a folder, is left alone.
    assert fixture.trim("category_config.json", to_json(rows)) == to_json(rows)
    assert fixture.trim("board/wnba.json", to_json(rows)) == to_json(rows)


def test_trim_player_keeps_every_key_and_recent_history() -> None:
    player = {
        "name": "A",
        "seasons": [{"season": "2025", "g": 1}, {"season": fixture.SEASON, "g": 2}],
        "game_log": [{"season": fixture.SEASON, "game_id": str(i)} for i in range(30)],
        "shots": [[0, 0, 1, 0]] * 400,
        "board": {"rank_total": 1},
    }
    out = json.loads(fixture.trim_player(to_json(player)))
    assert set(out) == set(player)
    assert out["seasons"] == [{"season": fixture.SEASON, "g": 2}]
    assert len(out["game_log"]) == fixture.RECENT_GAMES
    assert out["game_log"][-1]["game_id"] == "29"
    assert len(out["shots"]) == fixture.RECENT_SHOTS
    assert out["board"] == {"rank_total": 1}


@pytest.mark.skipif(not DBT_DB.exists(), reason="dbt sample not built")
def test_conform_gives_live_files_the_keys_the_code_exports() -> None:
    shape = fixture.export_of(DBT_DB, log=lambda _: None)
    board_keys = set(json.loads(shape.files["health.json"]).keys())
    live = {
        # a stale column the code dropped, and none of the columns it added since
        "board/wnba.json": to_json([{"league": "wnba", "player_id": "1", "old_column": 1}]),
        "health.json": to_json({"build_id": "x", "stale_section": []}),
        "notebooks/index.json": b'{"files": []}',
    }
    out = fixture.conform(live, shape, DBT_DB)
    board = json.loads(out["board/wnba.json"])
    assert "old_column" not in board[0]
    assert board[0]["player_id"] == "1" and board[0]["rank_total"] is None
    assert set(json.loads(out["health.json"])) == board_keys
    assert out["notebooks/index.json"] == live["notebooks/index.json"]
