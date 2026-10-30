"""The schema file the Schema page renders (ops/schema.py)."""

from __future__ import annotations

from typing import Any

from export import layout
from ops import schema

BRONZE = """{{ config(partition_by=(['league', 'season'] if target.type == 'databricks')) }}

{# Raw espn `summary` payloads parsed to rows.

- one row per athlete #}

with files as (
    select * from ({{ landing_files('espn', 'summary') }}) as landed
)
select * from files
"""

GOLD = """{# One row per player per game. #}
select
    {{ sk(['b.league', 'b.game_id', 'b.player_id']) }} as player_game_sk,
    {{ sk(['b.league', "cast(b.valid_from as string)"]) }} as other_sk,
    {{ sk(['b.league', 'b.game_id']) }} as game_sk
from {{ ref('player_game_box') }} as b
"""


def test_notes_skip_a_leading_config_block() -> None:
    assert schema.model_notes(BRONZE) == [
        "Raw espn `summary` payloads parsed to rows.",
        "- one row per athlete",
    ]
    assert schema.model_notes("{# A plain comment. #}\nselect 1") == ["A plain comment."]
    assert schema.model_notes("select 1 {# too late #}") == []


def test_grain_is_the_models_own_key_without_aliases_or_casts() -> None:
    cols = {"player_game_sk", "game_sk", "league", "game_id", "player_id"}
    grain = schema.model_grain(GOLD, cols, "player_game_sk")
    assert grain == {"key": "player_game_sk", "columns": ["league", "game_id", "player_id"]}
    assert schema.model_grain(GOLD, cols, "other_sk") == {
        "key": "other_sk",
        "columns": ["league", "valid_from"],
    }
    # dim_player keys on the SQL's player_id and publishes it as stats_player_id.
    renamed = schema.model_grain(GOLD, {"league", "game_id", "stats_player_id"}, "player_game_sk")
    assert renamed and renamed["columns"] == ["league", "game_id", "stats_player_id"]
    assert schema.model_grain("select 1", cols, None) is None


def test_landing_reads_name_source_and_endpoint() -> None:
    assert schema.landing_reads(BRONZE) == ["espn/summary"]
    ops_sql = "with f as ({{ raw_json_files('landing/_ops/ingest_log/*/*.json') }}) select 1"
    assert schema.landing_reads(ops_sql) == ["_ops/ingest_log"]


def test_export_consumers_follow_the_export_layout() -> None:
    players = "select * from fct_player_game as g left join dim_game as d on 1 = 1"
    out = schema.export_consumers(players, {"fct_player_game", "dim_game", "mart_board"})
    assert out["mart_board"][:2] == ["mart_board.parquet", "board/<league>.json"]
    assert "fct_player_game/<league>-<season>.parquet" in out["fct_player_game"]
    assert "players/<league>/<player_id>.json" in out["dim_game"]
    assert "players/<league>/<player_id>.json" not in out["mart_board"]
    assert out["category_config"] == ["category_config.parquet", "category_config.json"]


def _manifest() -> dict[str, Any]:
    def model(name: str, layer: str, raw: str, deps: list[str]) -> dict[str, Any]:
        return {
            "resource_type": "model",
            "package_name": "fantasyscout",
            "name": name,
            "schema": layer,
            "config": {"materialized": "table"},
            "description": f"{name} model",
            "raw_code": raw,
            "depends_on": {"nodes": deps},
            "columns": {"player_game_sk": {"description": "Key"}},
        }

    unique = {
        "resource_type": "test",
        "package_name": "fantasyscout",
        "name": "unique_fct_player_game_player_game_sk",
        "test_metadata": {"name": "unique", "kwargs": {}},
        "column_name": "player_game_sk",
        "attached_node": "model.fantasyscout.fct_player_game",
        "depends_on": {"nodes": ["model.fantasyscout.fct_player_game"]},
        "config": {},
    }
    return {
        "nodes": {
            "model.fantasyscout.espn_summary_players": model(
                "espn_summary_players", "bronze", BRONZE, []
            ),
            "model.fantasyscout.fct_player_game": model(
                "fct_player_game", "gold", GOLD, ["model.fantasyscout.espn_summary_players"]
            ),
            "test.fantasyscout.unique": unique,
        },
        "unit_tests": {
            "unit_test.fantasyscout.fct_player_game.adds_up": {
                "name": "adds_up",
                "model": "fct_player_game",
                "package_name": "fantasyscout",
                "description": "Points add\n up.\n",
            }
        },
    }


def test_build_carries_landing_grain_unit_tests_and_exports() -> None:
    catalog = {
        "nodes": {
            "model.fantasyscout.fct_player_game": {
                "columns": {
                    "player_game_sk": {"name": "player_game_sk", "type": "VARCHAR", "index": 1},
                    "points": {"name": "points", "type": "INTEGER", "index": 2},
                }
            }
        }
    }
    out = schema.build(_manifest(), catalog, {}, "select * from fct_player_game")
    bronze, _, gold, _ = out["layers"]
    summary = bronze["models"][0]
    assert summary["landing"] == ["espn/summary"]
    assert summary["notes"][0].startswith("Raw espn")
    assert out["landing"] == [{"path": "espn/summary", "read_by": ["espn_summary_players"]}]
    fact = gold["models"][0]
    assert fact["grain"] == {"key": "player_game_sk", "columns": ["league", "game_id", "player_id"]}
    assert fact["unit_tests"] == [{"name": "adds_up", "description": "Points add up."}]
    assert out["unit_tests"][0]["model"] == "fct_player_game"
    assert "players/<league>/<player_id>.json" in fact["exported_as"]
    assert [c["type"] for c in fact["columns"]] == ["varchar", "integer"]


def test_require_docs_lists_exported_gold_columns_without_a_description() -> None:
    columns = [{"name": c, "description": "described"} for c in layout.BOARD_COLUMNS]
    columns.append({"name": "rank_total", "description": ""})
    models = [{"name": "mart_board", "columns": columns}]
    problems = schema.undocumented({"layers": [{"name": "gold", "models": models}]})
    assert "mart_board.rank_total: no description" in problems
    assert "mart_streamers: not in the dbt project" in problems
    assert any(p.startswith("mart_streamers.") and "not a column" in p for p in problems)
    assert not any(p.startswith("mart_board.") and "not a column" in p for p in problems)
