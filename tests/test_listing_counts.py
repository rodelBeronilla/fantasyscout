"""The Mondays' listing counts read the landed files as they are (#1140). Invented files only."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from ops import listing_counts as lc


def _write(path: Path, body: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body), encoding="utf-8")


def test_the_mondays_espn_file_gives_its_fetch_time_and_count(tmp_path: Path) -> None:
    folder = tmp_path / "landing" / "espn" / "injuries" / "nba" / "2026-27" / "2026-11-16"
    team = {"injuries": [{"status": "Out"}, {"status": "Questionable"}, {"status": "Doubtful"}]}
    _write(folder / "league.json", {"timestamp": "2026-11-16T09:41:03Z", "injuries": [team]})
    _write(folder / "league.meta.json", {"fetched_at": "2026-11-16T09:41:02Z"})
    row = lc.espn_landing(tmp_path, "nba", "2026-27", date(2026, 11, 16))
    assert row == {
        "landed": True,
        "espn_timestamp": "2026-11-16T09:41:03Z",
        "league_wide_out_or_doubtful": 2,
        "fetched_at": "2026-11-16T09:41:02Z",
    }
    assert lc.espn_landing(tmp_path, "nba", "2026-27", date(2026, 11, 9)) == {"landed": False}


def test_only_a_report_published_before_twelve_utc_on_its_day_counts_as_early(
    tmp_path: Path,
) -> None:
    base = tmp_path / "landing" / "league" / "injury_report" / "nba" / "2023-24" / "2026-10-27"
    _write(base / "a.json", {"published_et": "2024-01-15T17:00:00-05:00"})  # 22:00 UTC
    _write(base / "b.json", {"published_et": "2024-01-15T06:30:00-05:00"})  # 11:30 UTC
    _write(base / "b.meta.json", {"fetched_at": "2026-10-27T09:00:00Z"})
    assert lc.early_reports(tmp_path, "nba") == {
        "2023-24": {"reports": 2, "before_the_morning_cut": 1}
    }
