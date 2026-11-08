"""The one-line notes on flagged players (#823): every number and quotation traced to its inputs."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import duckdb
import pytest

from ai import client, player_notes
from ai.player_note_check import check, text_numbers

INP: dict[str, Any] = {
    "player_id": "7",
    "name": "Test Player",
    "team": "TST",
    "injury_status": "Out",
    "news_flag": None,
    "row_ref": "mart_board/nba/7/2026-11-08",
    "metrics": {
        "rank": {"after": 58},
        "expected_games_missed": {"after": 4.6},
        "availability_share": {"after": 0.61},
    },
    "texts": [
        {
            "what": "injury note",
            "text": "Player (ankle) will be re-evaluated in 2-3 weeks, the team said Friday.",
            "row_ref": "mart_board/nba/7/2026-11-08",
            "quotable": False,
        },
        {
            "what": "claim: will miss games",
            "text": "will be re-evaluated in 2-3 weeks",
            "row_ref": "fct_player_claim/nba/espn_injury_note/91-abc",
            "quotable": False,
        },
        {
            "what": "flagged ESPN headline",
            "text": "Test Player sidelined with ankle sprain",
            "row_ref": "mart_board/nba/7/2026-11-08",
            "quotable": True,
        },
        {
            "what": "claim: will miss games",
            "text": "he's going to miss about 10 days",
            "row_ref": "fct_player_claim/nba/youtube:hoops-talk/abc123-t90",
            "quotable": False,
        },
        {
            "what": "claim: will miss games",
            "text": "Test Player out with ankle sprain",
            "row_ref": "fct_player_claim/nba/youtube:hoops-talk/abc123",
            "quotable": True,
        },
    ],
}


def line(text: str, **extra: Any) -> dict[str, Any]:
    return {"player_id": "7", "line": text, **extra}


def test_a_line_whose_numbers_and_quotes_are_all_in_its_inputs_passes_with_sources() -> None:
    note, reasons = check(
        line(
            'Out with an ankle injury, "sidelined with ankle sprain" per ESPN;'
            " expected to miss 4.6 games, so hold him on the IL."
        ),
        INP,
    )
    assert reasons == []
    assert note is not None
    assert [(s.what, s.value) for s in note.sources] == [
        ("flagged ESPN headline", "sidelined with ankle sprain"),
        ("expected_games_missed", "4.6"),
    ]


def test_a_youtube_transcript_and_an_injury_note_lend_numbers_but_are_never_quoted() -> None:
    # quoting what was said in a video is dropped, though the words are in the inputs
    note, reasons = check(line('Out, "going to miss about 10 days"; hold him for 4.6 games.'), INP)
    assert note is None
    assert any("not a span of a headline, title or description" in r for r in reasons), reasons
    # and the reason does not repeat the words
    assert all("going to miss" not in r for r in reasons)
    # quoting the injury note's prose is dropped too
    assert check(line('Out, "re-evaluated in 2-3 weeks"; hold him.'), INP)[0] is None
    # their numbers, in the line's own words, are fine: traced to the transcript claim's row
    note, reasons = check(line("Out about 10 days per a video; hold him."), INP)
    assert reasons == []
    assert note is not None
    assert note.sources[0].row_ref == "fct_player_claim/nba/youtube:hoops-talk/abc123-t90"
    # a YouTube video's title may be quoted
    title, _ = check(line('"out with ankle sprain", a video says; miss 4.6 games.'), INP)
    assert title is not None


def test_only_headline_title_and_description_claims_may_be_quoted() -> None:
    assert player_notes.quotable_claim("espn_news", "401")
    assert player_notes.quotable_claim("rss:hoops-rumors", "i9")
    assert player_notes.quotable_claim("youtube:hoops-talk", "abc123")
    assert not player_notes.quotable_claim("youtube:hoops-talk", "abc123-t90")
    assert not player_notes.quotable_claim("espn_injury_note", "91-abc")


def test_a_number_from_a_text_is_traced_to_that_texts_row() -> None:
    note, _ = check(line("Out 2 to 3 weeks per the injury note; plays 61% of games."), INP)
    assert note is not None
    assert [(s.what, s.row_ref) for s in note.sources] == [
        ("injury note", INP["row_ref"]),
        ("injury note", INP["row_ref"]),
        ("availability_share", INP["row_ref"]),
    ]


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("Out; expected to miss 6 games.", "6"),  # 4.6 rounds to 5, not 6
        ("Out; expected to miss 4.62 games.", "4.62"),  # more precise than the input
        ("He scored 30 last night; hold him.", "30"),
        ('Out, "out for the season" per ESPN; drop him.', "not a span of a headline"),
        ("Out with an ankle injury; hold him on the IL.", "no number or quotation"),
    ],
)
def test_a_line_with_a_number_or_quote_not_in_its_inputs_is_dropped(text: str, reason: str) -> None:
    note, reasons = check(line(text), INP)
    assert note is None
    assert any(reason in r for r in reasons), reasons


def test_a_line_about_another_player_too_long_or_on_two_lines_is_dropped() -> None:
    assert check(line("Expected to miss 4.6 games.", player_id="8"), INP)[0] is None
    assert check(line(" ".join(["word"] * 31) + " 4.6"), INP)[0] is None
    assert check(line("Expected to miss 4.6 games.\nHold him."), INP)[0] is None
    assert check({"line": "x"}, INP)[0] is None


def test_text_numbers_read_a_date_and_a_range_without_their_dashes() -> None:
    assert text_numbers("back 2026-11-12, out 2-3 weeks") == [2026, 11, 12, 2, 3]


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        "create table mart_board (league varchar, player_id varchar, full_name varchar,"
        " team_abbreviation varchar, rank_total int, value_rest_of_season double,"
        " proj_minutes_pg double, availability_multiplier double, expected_games_missed double,"
        " games_this_week int, games_remaining int, injury_status varchar, injury_group varchar,"
        " injury_type varchar, expected_return date, injury_note varchar, news_flag varchar,"
        " news_headline varchar, news_date date)"
    )
    rows = [
        # out, ranked: flagged
        ("p1", 10, "Out", "out", "Ankle", "2026-11-20", "Will miss 2 weeks.", None, None),
        # a flagged headline and no listing: flagged
        ("p2", 40, None, None, None, None, None, "role", "Starts Friday"),
        # healthy, nothing flagged
        ("p3", 20, None, None, None, None, None, None, None),
        # out, but deep on the waiver wire
        ("p4", 450, "Out", "out", "Knee", None, None, None, None),
    ]
    for pid, rank, status, group, kind, back, note, flag, headline in rows:
        con.execute(
            "insert into mart_board values ('nba', ?, ?, 'TST', ?, 5.25, 30.04, 0.8, 3.0, 3, 70,"
            " ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                pid,
                f"Player {pid}",
                rank,
                status,
                group,
                kind,
                back,
                note,
                flag,
                headline,
                "2026-11-07" if headline else None,
            ],
        )
    con.execute(
        "create table fct_player_claim (league varchar, stats_player_id varchar, source varchar,"
        " source_id varchar, kind varchar, quote varchar, confidence double, published_date date)"
    )
    con.execute(
        "insert into fct_player_claim values"
        " ('nba', 'p1', 'espn_news', '42', 'injury_out', 'out two weeks', 0.8, '2026-11-07'),"
        " ('nba', 'p1', 'espn_news', '41', 'injury_out', 'out', 0.8, '2026-10-01')"
    )
    con.execute(
        "create table fct_player_rss_item (league varchar, stats_player_id varchar,"
        " item_id varchar, outlet varchar, title varchar, published_date date)"
    )
    con.execute(
        "insert into fct_player_rss_item values"
        " ('nba', 'p2', 'i9', 'Hoops Rumors', 'Player p2 to start Friday', '2026-11-06')"
    )
    return con


def test_inputs_pick_the_flagged_players_with_their_numbers_and_recent_news(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(player_notes, "connect", lambda _source: _con())
    monkeypatch.setattr(player_notes, "build_id", lambda: "b1")
    data = player_notes.make_inputs("local", today=date(2026, 11, 8))
    nba = next(s for s in data["sets"] if s["league"] == "nba")
    assert [p["player_id"] for p in nba["players"]] == ["p1", "p2"]
    p1, p2 = nba["players"]
    assert p1["metrics"]["value_rest_of_season"] == {"after": 5.2}
    assert p1["metrics"]["projected_minutes"] == {"after": 30.0}
    assert p1["row_ref"] == "mart_board/nba/p1/2026-11-08"
    # the injury note, the return date and the recent claim; the month-old claim is left out
    assert [t["what"] for t in p1["texts"]] == [
        "injury note",
        "expected return",
        "claim: will miss games",
    ]
    assert p1["texts"][2]["row_ref"] == "fct_player_claim/nba/espn_news/42"
    # a headline's claim may be quoted; the injury note's prose may not
    assert [t["quotable"] for t in p1["texts"]] == [False, False, True]
    assert [n["may quote"] for n in player_notes.model_view(p1)["news"]] == [False, False, True]
    assert [t["what"] for t in p2["texts"]] == [
        "flagged ESPN headline",
        "headline from Hoops Rumors",
    ]
    view = player_notes.model_view(p1)
    assert view["numbers"]["games expected to miss"] == 3.0
    assert "expected_games_missed" not in view["numbers"]


def test_review_publishes_passing_lines_and_logs_the_rest(tmp_path: Path) -> None:
    inputs = {
        "build_id": "b1",
        "sets": [{"league": "nba", "as_of": "2026-11-08", "players": [INP]}],
    }
    good = {
        "model": "m",
        "drafts": [{"league": "nba", "player_id": "7", "note": line("Miss 4.6 games; hold.")}],
    }
    leagues = player_notes.publish(inputs, good, store_kind="local", out=tmp_path)
    doc = json.loads((tmp_path / "notes" / "players" / "nba.json").read_text(encoding="utf-8"))
    assert doc == leagues["nba"] | {"notes": doc["notes"]}
    assert doc["notes"]["7"]["line"] == "Miss 4.6 games; hold."
    assert doc["notes"]["7"]["injury_status"] == "Out"
    assert doc["counts"] == {"drafted": 1, "published": 1, "rejected": 0}
    bad = {
        "model": "m",
        "drafts": [{"league": "nba", "player_id": "7", "note": line("Miss 9 games.")}],
    }
    rejected = player_notes.review(inputs, bad)["nba"]
    assert rejected["notes"] == {}
    assert "9" in rejected["rejected"][0]["reasons"][0]


def test_nothing_is_drafted_or_published_while_the_model_is_away(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(client, "unavailable", lambda **_: "not reachable")
    inputs = {
        "build_id": "b1",
        "sets": [{"league": "nba", "as_of": "2026-11-08", "players": [INP]}],
    }
    drafts = player_notes.draft(inputs)
    assert drafts["drafts"] == []
    assert player_notes.publish(inputs, drafts, store_kind="local", out=tmp_path) == {}
    assert not (tmp_path / "notes").exists()
