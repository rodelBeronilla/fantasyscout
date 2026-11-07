"""Saved tables land once, tagged with their source and page, and a wrong file is named (#792)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from ingest.manual import check_saved, import_files
from ingest.store import LocalBackend

SAVED = {
    "url": "https://www.example.com/contracts/player-1",
    "title": "Player One contract",
    "saved_at": "2026-11-07T22:00:00Z",
    "tables": [
        {
            "label": "Contract",
            "headers": ["Season", "Salary"],
            "rows": [[{"text": "2025-26", "href": None}, {"text": "$1,000,000", "href": None}]],
        }
    ],
}


def test_a_saved_file_lands_once_with_its_source_and_page(tmp_path: Path) -> None:
    saved = tmp_path / "saved.json"
    saved.write_text(json.dumps(SAVED), encoding="utf-8")
    root = tmp_path / "root"
    now = datetime(2026, 11, 7, 23, tzinfo=UTC)
    first = import_files(
        LocalBackend(root), [saved], source="spotrac", league="nba", season="2025-26", now=now
    )
    again = import_files(
        LocalBackend(root), [saved], source="spotrac", league="nba", season="2025-26", now=now
    )
    assert (first.landed, first.unchanged, again.landed, again.unchanged) == (1, 0, 0, 1)
    found = (root / "landing/manual/saved_tables/nba/2025-26").rglob("spotrac-*.json")
    [landed] = [f for f in found if not f.name.endswith(".meta.json")]
    body = json.loads(landed.read_text(encoding="utf-8"))
    assert body["source"] == "spotrac" and body["file"] == "saved.json"
    assert body["tables"][0]["rows"][0][1]["text"] == "$1,000,000"
    meta = json.loads(landed.with_name(landed.stem + ".meta.json").read_text(encoding="utf-8"))
    assert meta["url"] == SAVED["url"]


def test_a_file_that_is_not_a_saved_page_is_named_and_not_landed(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"tables": []}), encoding="utf-8")
    junk = tmp_path / "junk.json"
    junk.write_text("not json", encoding="utf-8")
    result = import_files(
        LocalBackend(tmp_path / "root"), [bad, junk], source="pst", league="nba", season="2025-26"
    )
    assert result.landed == 0
    assert result.rejected == ["bad.json: no page address (url)", "junk.json: not JSON"]
    assert check_saved({**SAVED, "tables": []}) == "no tables"
    with pytest.raises(ValueError, match="--source"):
        import_files(LocalBackend(tmp_path), [], source="Spot Rac", league="nba", season="x")
