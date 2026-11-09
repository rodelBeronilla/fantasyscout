"""The feature list is well formed, its references are real, and the web reads it current (#947)."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from ops import features, parameters

PARAMS = {str(p["id"]) for p in parameters.load()}


def test_the_list_is_well_formed() -> None:
    assert features.problems(features.load(), PARAMS) == []


def test_the_generated_module_is_current() -> None:
    assert features.OUT.read_text(encoding="utf-8") == features.render(features.load())


def test_every_week_level_bar_has_its_two_looks() -> None:
    # #936 rule 4: judged on 2026-27's weeks in mid-January and mid-March
    dated = [f for f in features.load()["features"] if "dates" in f]
    assert dated, "the week-level features carry their judging dates"
    for f in dated:
        assert f["dates"] == [dt.date(2027, 1, 18), dt.date(2027, 3, 15)], f["id"]
        assert "bar" in f, f"{f['id']}: a dated judgement links its pass bar"


def test_a_bad_row_is_named(tmp_path: Path) -> None:
    (tmp_path / "0001-x.md").write_text("# 0001", encoding="utf-8")
    row = {
        "id": "x",
        "what": "w",
        "page": "nowhere",
        "verdict": "maybe",
        "switch": "s",
        "shown": "shown",
        "adr": 2,
        "parameters": ["no.such"],
        "next": "n",
        "dates": [dt.date(2027, 3, 15), dt.date(2027, 1, 18)],
        "bar": "https://example.com",
    }
    data = {"pages": {"team": {"label": "My Team"}}, "features": [row, dict(row)]}
    found = features.problems(data, PARAMS, tmp_path)
    for expected in (
        "verdict 'maybe'",
        "either a switch or whether it is shown",
        "page 'nowhere'",
        "ADR 2 is not in docs/adr",
        "names the issue that tracks it",
        "parameter no.such",
        "dates must be YYYY-MM-DD, in order",
        "the bar must be a comment on its issue",
        "listed twice",
        "switch s is named by more than one feature",
    ):
        assert any(expected in f for f in found), expected
    ok = {**row, "page": "team", "verdict": "data", "adr": 1, "parameters": [], "dates": []}
    del ok["shown"], ok["bar"]
    assert features.problems({"pages": data["pages"], "features": [ok]}, PARAMS, tmp_path) == []
