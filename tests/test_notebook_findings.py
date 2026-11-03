"""Notebook findings are JSON the Notebooks page can parse (#678)."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "notebooks"))
import fs


def test_save_findings_writes_nan_and_infinity_as_null(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    findings = {
        "title": "Streamer signals",
        "leagues": {
            "nba": {
                "headline": "h",
                "facts": [{"label": "r", "value": math.nan}],
                "table": {
                    "columns": ["signal", "r"],
                    "rows": [["Touches trend", math.nan], ["Games", math.inf], ("t", -math.inf)],
                },
                "n": 3,
            }
        },
    }
    path = fs.save_findings("02_streamer_signals", findings)
    text = path.read_text(encoding="utf-8")
    assert "NaN" not in text and "Infinity" not in text
    # strict JSON, as a browser parses it
    data = json.loads(text, parse_constant=lambda c: pytest.fail(f"non-JSON constant {c}"))
    nba = data["leagues"]["nba"]
    assert nba["facts"][0]["value"] is None
    assert nba["table"]["rows"] == [["Touches trend", None], ["Games", None], ["t", None]]
    assert nba["n"] == 3
