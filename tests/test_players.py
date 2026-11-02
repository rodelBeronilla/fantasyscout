"""The per-player file, section by section, from small hand-made gold tables (#483)."""

from __future__ import annotations

from datetime import date
from typing import Any

import pyarrow as pa
import pytest

from export import layout
from export.players import BOX, PlayerFiles, assemble


def _table(rows: list[dict[str, Any]]) -> pa.Table:
    return pa.Table.from_pylist(rows)


def _game(
    player: str, season: str, game: str, day: date, *, played: bool, home: bool, **box: float
) -> dict[str, Any]:
    return {
        "league": "wnba",
        "player_id": player,
        "season": season,
        "game_id": game,
        "game_date": day,
        "is_home": home,
        "team_tricode": "LVA",
        "played": played,
        "comment": None if played else "DNP",
        **{c: box.get(c, 0.0) for c in BOX},
        "plus_minus": 1.0,
        "source_agreement": "exact",
    }


def _wide(columns: tuple[str, ...], **values: Any) -> dict[str, Any]:
    """A row with every layout column (1.0 unless given), plus league and player."""
    row: dict[str, Any] = {"league": "wnba", "player_id": "1"}
    for c in columns:
        row[c] = values.get(c, 1.0)
    return row


@pytest.fixture
def files() -> PlayerFiles:
    tables = {
        "dim_player": _table(
            [
                {
                    "league": "wnba",
                    "stats_player_id": "1",
                    "espn_player_id": "e1",
                    "full_name": "Ana Old",
                    "position": "G",
                    "height": "5-9",
                    "weight_lbs": 150,
                    "birth_date": date(1998, 1, 1),
                    "school": "X",
                    "team_id": "t1",
                    "valid_from": date(2024, 5, 1),
                    "valid_to": date(2025, 9, 1),
                    "is_current": False,
                    "last_game_date": date(2026, 9, 1),
                },
                {
                    "league": "wnba",
                    "stats_player_id": "1",
                    "espn_player_id": "e1",
                    "full_name": "Ana New",
                    "position": "G",
                    "height": "5-9",
                    "weight_lbs": 150,
                    "birth_date": date(1998, 1, 1),
                    "school": "X",
                    "team_id": "t2",
                    "valid_from": date(2025, 9, 2),
                    "valid_to": None,
                    "is_current": True,
                    "last_game_date": date(2026, 9, 1),
                },
            ]
        ),
        "dim_team": _table(
            [
                {
                    "league": "wnba",
                    "team_id": "t1",
                    "season": "2025",
                    "abbreviation": "OLD",
                    "name": "Old name",
                },
                {
                    "league": "wnba",
                    "team_id": "t2",
                    "season": "2025",
                    "abbreviation": "AAA",
                    "name": "Earlier",
                },
                {
                    "league": "wnba",
                    "team_id": "t2",
                    "season": "2026",
                    "abbreviation": "LVA",
                    "name": "Aces",
                },
            ]
        ),
        "fct_player_game": _table(
            [
                _game("1", "2025", "g0", date(2025, 6, 1), played=True, home=True, points=10.0),
                _game(
                    "1",
                    "2026",
                    "g1",
                    date(2026, 6, 1),
                    played=True,
                    home=True,
                    points=20.0,
                    field_goals_made=8.0,
                    field_goals_attempted=16.0,
                ),
                _game("1", "2026", "g2", date(2026, 6, 3), played=False, home=False),
            ]
        ),
        "dim_game": _table(
            [
                {
                    "league": "wnba",
                    "game_id": "g1",
                    "home_team_abbreviation": "LVA",
                    "away_team_abbreviation": "NYL",
                },
                {
                    "league": "wnba",
                    "game_id": "g2",
                    "home_team_abbreviation": "SEA",
                    "away_team_abbreviation": "LVA",
                },
            ]
        ),
        "mart_player_rolling": _table(
            [
                _wide(
                    layout.PLAYER_ROLLING_COLUMNS,
                    season="2025",
                    game_id="g0",
                    game_date=date(2025, 6, 1),
                    game_number=1,
                ),
                _wide(
                    layout.PLAYER_ROLLING_COLUMNS,
                    season="2026",
                    game_id="g1",
                    game_date=date(2026, 6, 1),
                    game_number=1,
                ),
            ]
        ),
        "mart_category_zscores": _table(
            [_wide(layout.PLAYER_ZSCORE_COLUMNS, window_name="season", season="2026", games=2)]
        ),
        "mart_board": _table([_wide(layout.PLAYER_BOARD_COLUMNS, rank_total=3)]),
        "fct_shot": _table(
            [
                {
                    "league": "wnba",
                    "player_id": "1",
                    "season": "2026",
                    "game_date": date(2026, 6, 1),
                    "game_id": "g1",
                    "game_event_id": 1,
                    "loc_x": 1.0,
                    "loc_y": 2.0,
                    "shot_made": True,
                    "is_three": False,
                    "shot_zone_basic": "Paint",
                    "shot_distance": 3.0,
                },
                {
                    "league": "wnba",
                    "player_id": "1",
                    "season": "2026",
                    "game_date": date(2026, 6, 1),
                    "game_id": "g1",
                    "game_event_id": 2,
                    "loc_x": 5.0,
                    "loc_y": 9.0,
                    "shot_made": False,
                    "is_three": True,
                    "shot_zone_basic": "Above the Break 3",
                    "shot_distance": 24.0,
                },
                {
                    "league": "wnba",
                    "player_id": "2",
                    "season": "2026",
                    "game_date": date(2026, 6, 1),
                    "game_id": "g1",
                    "game_event_id": 3,
                    "loc_x": 0.0,
                    "loc_y": 1.0,
                    "shot_made": False,
                    "is_three": False,
                    "shot_zone_basic": "Paint",
                    "shot_distance": 2.0,
                },
                {
                    "league": "wnba",
                    "player_id": "1",
                    "season": "2025",
                    "game_date": date(2025, 6, 1),
                    "game_id": "g0",
                    "game_event_id": 1,
                    "loc_x": 9.0,
                    "loc_y": 9.0,
                    "shot_made": True,
                    "is_three": True,
                    "shot_zone_basic": "Corner 3",
                    "shot_distance": 22.0,
                },
            ]
        ),
    }
    maker = PlayerFiles(tables)
    yield maker
    maker.close()


KEY = ("wnba", "1")


def test_the_current_season_is_the_newest_with_a_box_score(files: PlayerFiles) -> None:
    assert files.current_seasons() == {"wnba": "2026"}


def test_bios_keep_every_stint_oldest_first_with_the_teams_latest_name(files: PlayerFiles) -> None:
    stints = files.bios()[KEY]
    assert [s["team_id"] for s in stints] == ["t1", "t2"]
    assert stints[1]["team_abbreviation"] == "LVA"
    assert stints[1]["team_name"] == "Aces"


def test_a_season_line_averages_the_games_played_only(files: PlayerFiles) -> None:
    lines = {s["season"]: s for s in files.seasons()[KEY]}
    assert lines["2026"]["games"] == 2
    assert lines["2026"]["games_played"] == 1
    assert lines["2026"]["points_pg"] == 20.0
    assert lines["2026"]["field_goal_pct"] == 0.5
    assert lines["2026"]["agree_exact"] == 2


def test_the_game_log_names_the_opponent_from_either_side(files: PlayerFiles) -> None:
    log = {g["game_id"]: g for g in files.game_log()[KEY]}
    assert log["g1"]["opponent"] == "NYL"  # at home: the visitors
    assert log["g2"]["opponent"] == "SEA"  # away: the hosts
    assert log["g0"]["opponent"] is None  # no dim_game row


def test_rolling_shots_and_zones_are_the_current_season_only(files: PlayerFiles) -> None:
    assert [r["game_id"] for r in files.rolling()[KEY]] == ["g1"]
    assert {s["shot_zone_basic"] for s in files.shots()[KEY]} == {"Paint", "Above the Break 3"}
    zones = {z["zone"]: z for z in files.zones()[KEY]}
    assert zones["Paint"]["attempts"] == 1 and zones["Paint"]["made"] == 1
    assert files.league_zones()["wnba"]["Paint"] == 0.5  # one of two league paint shots made


def test_a_build_without_the_optional_tables_has_empty_sections(files: PlayerFiles) -> None:
    assert files.injuries() == {}
    assert files.moves() == {}
    assert files.news() == {}


def test_assemble_puts_one_players_file_together(files: PlayerFiles) -> None:
    built = files.build()
    assert set(built) == {KEY}
    f = built[KEY]
    assert f["name"] == "Ana New"  # the current stint
    assert f["team"] == {"team_id": "t2", "abbreviation": "LVA", "name": "Aces"}
    assert f["current_season"] == "2026"
    assert [s["team_id"] for s in f["stints"]] == ["t1", "t2"]
    assert f["board"]["rank_total"] == 3
    assert "league" not in f["seasons"][0] and "player_id" not in f["game_log"][0]
    assert f["shots"] == [[1.0, 2.0, 1, 0], [5.0, 9.0, 0, 1]]
    paint = next(z for z in f["shot_zones"] if z["zone"] == "Paint")
    assert paint == {"zone": "Paint", "attempts": 1, "made": 1, "pct": 1.0, "league_pct": 0.5}
    assert f["moves"] == [] and f["news"] == [] and f["injury_history"] == []


def test_assemble_without_a_board_row_or_a_current_stint() -> None:
    stint = {
        "espn_player_id": None,
        "full_name": "Solo",
        "position": None,
        "height": None,
        "weight_lbs": None,
        "birth_date": None,
        "school": None,
        "team_id": None,
        "team_abbreviation": None,
        "team_name": None,
        "last_game_date": None,
        "is_current": False,
        "valid_from": None,
        "valid_to": None,
    }
    empty: dict[str, Any] = {}
    sections = {
        name: empty
        for name in (
            "seasons",
            "game_log",
            "rolling",
            "zscores",
            "board",
            "moves",
            "news",
            "injury_history",
            "shots",
            "shot_zones",
        )
    }
    f = assemble(("nba", "9"), [stint], sections, None, {})
    assert f["name"] == "Solo"  # no current stint: the last one
    assert f["board"] is None
    assert f["shots"] == [] and f["shot_zones"] == []
