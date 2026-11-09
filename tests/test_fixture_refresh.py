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
    assert fixture.keeps("players/wnba/1.json") and fixture.keeps("players/nba/1.json")
    assert not fixture.keeps("players/other/1.json") and not fixture.keeps("players/nba/1.csv")
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


def test_player_files_are_the_top_of_each_board_and_the_fixture_streamers() -> None:
    """#942: the other league's player page is tested too, from the top of its board."""

    def rows(ids: range) -> bytes:
        return to_json([{"player_id": str(i)} for i in ids])

    files = {
        f"board/{fixture.LEAGUE}.json": rows(range(100)),
        f"streamers/{fixture.LEAGUE}.json": rows(range(500, 600)),
        f"board/{fixture.OTHER_LEAGUE}.json": rows(range(1000, 1100)),
    }
    paths = fixture.player_paths(files)
    league = {p for p in paths if p.startswith(f"players/{fixture.LEAGUE}/")}
    other = {p for p in paths if p.startswith(f"players/{fixture.OTHER_LEAGUE}/")}
    assert len(league) == fixture.BOARD_PLAYERS + fixture.STREAMER_PLAYERS
    assert other == {
        f"players/{fixture.OTHER_LEAGUE}/{i}.json"
        for i in range(1000, 1000 + fixture.OTHER_PLAYERS)
    }
    assert fixture.player_paths({}) == set()


def test_each_player_file_is_cut_to_its_own_leagues_season() -> None:
    assert fixture.season_of(f"players/{fixture.LEAGUE}/1.json") == fixture.SEASON
    assert fixture.season_of(f"players/{fixture.OTHER_LEAGUE}/1.json") == fixture.OTHER_SEASON
    player = {"seasons": [{"season": "2025-26", "g": 1}, {"season": fixture.OTHER_SEASON, "g": 2}]}
    out = json.loads(fixture.trim_player(to_json(player), fixture.OTHER_SEASON))
    assert out["seasons"] == [{"season": fixture.OTHER_SEASON, "g": 2}]


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
