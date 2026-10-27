from __future__ import annotations

from pathlib import Path

import pytest

from ingest import probe as probe_mod
from ingest.cli import build_parser, main


def test_land_parser_accepts_spec_flags() -> None:
    args = build_parser().parse_args(
        ["land", "espn", "--league", "nba", "--since", "2026-10-01", "--full-refresh"]
    )
    assert args.command == "land"
    assert args.source == "espn"
    assert args.league == "nba"
    assert args.since.isoformat() == "2026-10-01"
    assert args.full_refresh is True


def test_land_dry_run_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["land", "stats", "--dry-run"]) == 0
    assert "leaguegamelog" in capsys.readouterr().out


def test_land_exit_code_reflects_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import UTC, datetime

    from ingest import land as land_mod
    from ingest.run import RunSummary

    clean = RunSummary("espn", "wnba", "2026", datetime(2026, 10, 27, tzinfo=UTC))
    monkeypatch.setattr(land_mod, "land", lambda opts, **_: clean)
    assert main(["land", "espn"]) == 0
    clean.fail("injuries", "league", RuntimeError("HTTP 503"))
    assert main(["land", "espn"]) == 2


def test_probe_writes_report_and_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = [probe_mod.ProbeResult("stats-wnba", "https://x", True, 200, 12, 100, "JSON")]
    monkeypatch.setattr(probe_mod, "run_probe", lambda targets, **_: fake)
    monkeypatch.delenv("DATABRICKS_HOST", raising=False)
    out = tmp_path / "probe.json"
    assert main(["probe", "--out", str(out), "--markdown"]) == 0
    assert '"name": "stats-wnba"' in out.read_text(encoding="utf-8")
    captured = capsys.readouterr()
    assert "| stats-wnba | yes | 200 |" in captured.out
    assert "databricks: skipped" in captured.err
