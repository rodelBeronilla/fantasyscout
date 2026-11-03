from __future__ import annotations

import io
import json

import pytest

from ops.backfilling import backfilling, main, parse_title


def test_a_backfill_title_names_its_league_seasons() -> None:
    assert parse_title('Backfill nba ["2023-24","2024-25"] (both)') == [
        "nba:2023-24",
        "nba:2024-25",
    ]
    assert parse_title('Backfill wnba ["2019"] (stats)') == ["wnba:2019"]


def test_a_backfill_that_lands_no_box_scores_does_not_count() -> None:
    assert parse_title('Backfill nba ["2023-24"] (espn)') == []
    assert parse_title('Backfill nba ["2023-24"] (reports)') == []


def test_other_titles_and_bad_seasons_name_nothing() -> None:
    assert parse_title("Ingest") == []
    assert parse_title("Backfill") == []
    assert parse_title('Backfill mlb ["2024"] (both)') == []
    assert parse_title("Backfill nba 2023-24 (both)") == []
    assert parse_title('Backfill nba {"a": 1} (both)') == []


def test_only_unfinished_runs_count_each_season_once() -> None:
    runs = [
        {"status": "in_progress", "displayTitle": 'Backfill nba ["2023-24","2024-25"] (both)'},
        {"status": "queued", "displayTitle": 'Backfill nba ["2024-25"] (stats)'},
        {"status": "completed", "displayTitle": 'Backfill wnba ["2019"] (both)'},
    ]
    assert backfilling(runs) == ["nba:2023-24", "nba:2024-25"]


def test_main_prints_dbt_vars_and_a_notice_each(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    runs = [{"status": "in_progress", "displayTitle": 'Backfill wnba ["2018"] (both)'}]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(runs)))
    assert main() == 0
    out, err = capsys.readouterr()
    assert json.loads(out) == {"backfilling": ["wnba:2018"]}
    assert "::notice::assert_completeness leaves out wnba:2018" in err


def test_main_with_no_runs_prints_an_empty_list(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("not json"))
    assert main() == 0
    assert json.loads(capsys.readouterr().out) == {"backfilling": []}
