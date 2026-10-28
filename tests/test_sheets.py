from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tableau"))
import sheets


def test_cells_are_typed_for_tableau() -> None:
    assert sheets._cell("") == ""
    assert sheets._cell("12") == 12
    assert sheets._cell("12.5") == 12.5
    assert sheets._cell("true") == "true"
    assert sheets._cell("wnba") == "wnba"
    assert sheets._cell("2026-10-27T09:15:00") == "2026-10-27T09:15:00"


def test_push_creates_missing_tabs_and_replaces_each_one(tmp_path: Path) -> None:
    (tmp_path / "team_pace_ratings.csv").write_text(
        "league,team,pace\nwnba,ATL,86.8\n", encoding="utf-8"
    )
    (tmp_path / "player_value.csv").write_text(
        "league,player,rank\nwnba,A,1\nwnba,B,2\n", encoding="utf-8"
    )
    seen: list[tuple[str, str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read().decode() if request.method in ("POST", "PUT") else ""
        query = "?" + request.url.query.decode() if request.url.query else ""
        seen.append((request.method, request.url.path + query, body))
        if request.method == "GET":
            return httpx.Response(
                200, json={"sheets": [{"properties": {"title": "team_pace_ratings"}}]}
            )
        return httpx.Response(200, json={})

    client = sheets.SheetsClient(lambda: "tok", transport=httpx.MockTransport(handler))
    counts = sheets.push(client, "SHEET", tmp_path, log=lambda _: None)
    assert counts == {"team_pace_ratings": 1, "player_value": 2}
    methods = [m for m, _, _ in seen]
    assert methods == ["GET", "POST", "POST", "PUT", "POST", "PUT"]
    assert '"title":"player_value"' in seen[1][2] and '"title":"data_health"' in seen[1][2]
    assert "team_pace_ratings!A1:Z:clear" in seen[2][1]
    assert "valueInputOption=RAW" in seen[3][1]
    assert '[["league","team","pace"],["wnba","ATL",86.8]]' in seen[3][2]


def test_push_reports_api_errors() -> None:
    client = sheets.SheetsClient(
        lambda: "tok",
        transport=httpx.MockTransport(lambda r: httpx.Response(403, json={"error": "nope"})),
    )
    with pytest.raises(RuntimeError, match="HTTP 403"):
        client.tabs("SHEET")


def test_main_skips_when_not_configured(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("GOOGLE_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.delenv("TABLEAU_SHEET_ID", raising=False)
    assert sheets.main([]) == 0
    assert "not configured" in capsys.readouterr().out
