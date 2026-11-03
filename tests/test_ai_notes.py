"""The AI notes' validator and inputs (SPEC.md, "AI usage"; ADR 0017): no number from the model."""

from __future__ import annotations

from typing import Any

import duckdb
import pytest

from ai import notes
from ai.inputs import model_view, select
from ai.validate import check

INP: dict[str, Any] = {
    "player_id": "7",
    "name": "Test Player",
    "team": "TST",
    "reason": "faller",
    "row_ref": "fct_board_history/nba/7/2026-10-27..2026-11-03",
    "injury_before": None,
    "injury_after": "Out",
    "metrics": {
        "value_rest_of_season": {"before": 6.1, "after": 3.9, "change": -2.2},
        "rank": {"before": 31, "after": 58, "change": 27},
        "availability_share": {"before": 0.95, "after": 0.61, "change": -0.34},
    },
}


def draft(body: str, headline: str = "Test Player is out", **extra: Any) -> dict[str, Any]:
    return {"player_id": "7", "headline": headline, "body": body, "confidence": "high", **extra}


def test_a_note_whose_numbers_are_all_the_builds_passes_with_claims_traced_to_the_row() -> None:
    note, reasons = check(
        draft(
            "He is out. Rest-of-season value fell by 2.2 to 3.9,"
            " and he is expected to play 61% of games."
        ),
        INP,
    )
    assert reasons == []
    assert note is not None
    assert [(c.metric, c.value) for c in note.claims] == [
        ("value_rest_of_season.change", -2.2),
        ("value_rest_of_season.after", 3.9),
        ("availability_share.after", 0.61),
    ]
    assert {c.row_ref for c in note.claims} == {INP["row_ref"]}


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        ("He is out and plays 85% of games.", "85%"),  # a share the input does not hold
        ("Value fell by 2.25.", "2.25"),  # more precise than the build
        ("He scored 30 last night.", "30"),
        ("Value increased by 2.2 to 3.9.", "wrong way"),
        ("His board rank rose 27 places to 58.", "better"),
        ("Value fell by 2.2. Confidence: high.", "confidence"),
        ("He is out and should be dropped.", "no number"),
    ],
)
def test_a_note_with_a_number_not_the_builds_or_told_the_wrong_way_is_rejected(
    body: str, reason: str
) -> None:
    note, reasons = check(draft(body), INP)
    assert note is None
    assert any(reason in r for r in reasons), reasons


def test_a_note_about_another_player_or_off_schema_is_rejected() -> None:
    assert check({**draft("Value fell by 2.2."), "player_id": "8"}, INP)[0] is None
    assert check({"headline": "x"}, INP)[0] is None
    assert check(draft(" ".join(["word"] * 61) + " 2.2"), INP)[0] is None


def test_a_change_of_2_3_is_never_read_as_a_rank_of_2() -> None:
    inp = {
        **INP,
        "metrics": {
            "rank": {"before": 4, "after": 2, "change": -2},
            "projected_minutes": {"before": 31.5, "after": 33.8, "change": 2.3},
        },
    }
    note, _ = check(draft("Minutes rose by 2.3 to 33.8 and he climbed 2 places."), inp)
    assert note is not None
    assert ("projected_minutes.change", 2.3) in [(c.metric, c.value) for c in note.claims]


def test_the_model_sees_plain_names_not_keys() -> None:
    view = model_view(INP)
    assert "rest-of-season value" in view["numbers"]
    assert "value_rest_of_season" not in view["numbers"]
    assert view["injury status after"] == "Out"


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        "create table fct_board_history (league varchar, snapshot_date date, player_id varchar,"
        " rank_total int, value_rest_of_season double, proj_minutes_pg double,"
        " proj_points_pg double, proj_rebounds_total_pg double, proj_assists_pg double,"
        " availability_multiplier double, games_remaining int, injury_status varchar,"
        " injury_group varchar)"
    )
    con.execute(
        "create table mart_board (league varchar, player_id varchar, full_name varchar,"
        " team_abbreviation varchar)"
    )
    rows: list[tuple[str, str, int, float, float, str | None]] = []
    for i in range(20):
        pid = f"p{i}"
        con.execute("insert into mart_board values ('nba', ?, ?, 'TST')", [pid, f"Player {i}"])
        before = 5.0
        after = 5.0 + (3.0 if i == 0 else -3.0 if i == 1 else 0.01 * i)
        minutes_after = 40.0 if i == 2 else 30.0
        group = "out" if i == 3 else None
        rows.append(("2026-10-27", pid, 50 + i, before, 30.0, None))
        rows.append(("2026-11-03", pid, 50 + i, after, minutes_after, group))
    for d, pid, rank, value, minutes, group in rows:
        con.execute(
            "insert into fct_board_history values ('nba', ?, ?, ?, ?, ?, 15, 6, 3, 1.0, 70, ?, ?)",
            [d, pid, rank, value, minutes, group.title() if group else None, group],
        )
    return con


def test_inputs_pick_risers_fallers_availability_and_minutes_without_the_model() -> None:
    picked = select(_con(), "nba", days=7, top=1)
    assert (picked["before"], picked["after"]) == ("2026-10-27", "2026-11-03")
    reasons = {p["player_id"]: p["reason"] for p in picked["players"]}
    assert reasons["p0"] == "riser"
    assert reasons["p1"] == "faller"
    assert reasons["p3"] == "availability"
    assert reasons["p2"] == "minutes"
    p0 = next(p for p in picked["players"] if p["player_id"] == "p0")
    assert p0["metrics"]["value_rest_of_season"] == {"before": 5.0, "after": 8.0, "change": 3.0}
    assert p0["row_ref"] == "fct_board_history/nba/p0/2026-10-27..2026-11-03"


def test_review_publishes_passing_notes_logs_rejections_and_scores_the_eval() -> None:
    inputs = {
        "build_id": "b1",
        "sets": [
            {
                "league": "nba",
                "before": "2026-10-27",
                "after": "2026-11-03",
                "kind": "current",
                "players": [INP],
            },
            {
                "league": "nba",
                "before": "2026-10-20",
                "after": "2026-10-27",
                "kind": "eval",
                "players": [INP],
            },
        ],
    }
    drafts = {
        "model": "qwen3:8b",
        "created_at": "2026-11-03T00:00:00+00:00",
        "drafts": [
            {
                "league": "nba",
                "after": "2026-11-03",
                "player_id": "7",
                "note": draft("Value fell by 2.2 to 3.9."),
            },
            {
                "league": "nba",
                "after": "2026-10-27",
                "player_id": "7",
                "note": draft("Value fell by 2.2 and he plays 85% of games."),
            },
        ],
    }
    result = notes.review(inputs, drafts)
    doc = result["leagues"]["nba"]
    assert doc["counts"]["published"] == 1
    assert doc["notes"][0]["claims"][0]["row_ref"] == INP["row_ref"]
    assert doc["label"] == notes.LABEL
    week = result["evals"]["nba"][0]
    assert (week["drafted"], week["rejected"], week["numbers_written"], week["numbers_traced"]) == (
        1,
        1,
        2,
        1,
    )
    summary = notes.eval_summary(result["evals"], "qwen3:8b")["leagues"]["nba"]
    assert summary["claim_accuracy"] == 0.5
    assert summary["rejection_rate"] == 1.0
