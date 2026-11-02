"""One row per build run, with the GitHub run, the gate, the build and the timings (#249)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from ops import build_log
from tests.test_results import artifacts

NOW = datetime(2026, 11, 1, 16, 30, tzinfo=UTC)

RUN = {"created_at": "2026-11-01T16:00:00Z"}
JOBS = {
    "jobs": [
        {
            "name": build_log.JOB_NAME,
            "started_at": "2026-11-01T16:05:00Z",
            "steps": [
                {
                    "name": "dbt build",
                    "conclusion": "success",
                    "started_at": "2026-11-01T16:06:00Z",
                    "completed_at": "2026-11-01T16:20:00Z",
                },
                {
                    "name": "Export gold to R2 (staged)",
                    "conclusion": "success",
                    "started_at": "2026-11-01T16:21:00Z",
                    "completed_at": "2026-11-01T16:25:00Z",
                },
                {"name": "Report", "conclusion": None, "started_at": "2026-11-01T16:29:00Z"},
            ],
        },
        {"name": "Deploy the Asset Bundle", "started_at": "2026-11-01T16:26:00Z", "steps": []},
    ]
}
MANIFEST = {"tables": {"gold.mart_board": {"rows": 600}, "gold.fct_event": {"rows": 900000}}}

ENV = {
    "GITHUB_REPOSITORY": "o/r",
    "GITHUB_RUN_ID": "41",
    "GITHUB_SERVER_URL": "https://github.com",
    "GITHUB_EVENT_NAME": "workflow_run",
    "GITHUB_SHA": "abcdef1234567890",
    "TRIGGER_RUN_ID": "40",
    "TRIGGER_RUN_URL": "https://github.com/o/r/actions/runs/40",
    "BUILD_ID": "20261101T162100Z-abcdef1",
    "SELECTED": "tag:feed_reports+ path:models/ops",
    "LIGHT": "true",
    "OUTCOME": "success",
    "SITE": "https://example.org",
}


def _api(path: str) -> dict[str, object] | None:
    if path.endswith("/jobs?per_page=100"):
        return JOBS
    if path.endswith("/runs/41"):
        return RUN
    return None


def test_collect_ties_the_run_the_gate_the_build_and_the_timings_together(tmp_path: Path) -> None:
    target = artifacts(tmp_path)
    record = build_log.collect(
        ENV,
        api=_api,
        fetch_json=lambda url: MANIFEST if url.endswith("/manifest.json") else None,
        target_dirs=[target, tmp_path / "absent"],
        now=NOW,
    )
    assert record.run_url == "https://github.com/o/r/actions/runs/41"
    assert record.queue_seconds == 300.0 and record.build_seconds == 840.0
    assert record.total_seconds == 1500.0
    assert record.steps["export"] == {"outcome": "success", "seconds": 240.0}
    assert "notebooks" not in record.steps  # a skipped step is simply absent
    assert record.gate_passed is True and record.gate_reason is not None
    assert record.gate_reason.startswith("selected build (tag:feed_reports+")
    assert record.invocation_id == "abcdef123456-7890"
    assert record.rows == {"gold.mart_board": 600, "gold.fct_event": 900000}
    assert record.light and record.trigger_run_id == "40" and record.git_sha == "abcdef123456"


def test_collect_copes_without_the_api_the_manifest_or_dbt_artifacts(tmp_path: Path) -> None:
    record = build_log.collect(
        {"OUTCOME": "failure"},
        api=lambda _: None,
        fetch_json=lambda _: None,
        target_dirs=[tmp_path],
        now=NOW,
    )
    assert record.run_id == "local" and record.run_url == ""
    assert record.gate_passed is None and record.steps == {} and record.rows == {}
    assert record.queue_seconds is None and record.total_seconds is None


def test_statements_create_and_insert_one_row_on_duckdb(tmp_path: Path) -> None:
    target = artifacts(tmp_path)
    record = build_log.collect(
        ENV, api=_api, fetch_json=lambda _: MANIFEST, target_dirs=[target], now=NOW
    )
    db = tmp_path / "lake.duckdb"
    build_log.write_duckdb(db, build_log.statements("ops", record))
    con = duckdb.connect(str(db), read_only=True)
    try:
        row = con.execute(
            "select run_id, build_id, light, gate_passed, queue_seconds, steps, rows"
            " from ops.build_log"
        ).fetchone()
    finally:
        con.close()
    assert row is not None
    assert row[:5] == ("41", "20261101T162100Z-abcdef1", True, True, 300.0)
    assert json.loads(row[5])["build"]["seconds"] == 840.0
    assert json.loads(row[6])["gold.mart_board"] == 600


def test_summary_names_the_gate_the_build_the_steps_and_the_rows(tmp_path: Path) -> None:
    target = artifacts(tmp_path)
    record = build_log.collect(
        ENV, api=_api, fetch_json=lambda _: MANIFEST, target_dirs=[target], now=NOW
    )
    text = build_log.summary_markdown(record)
    assert "## Build lakehouse: success" in text
    assert "Gate: passed" in text and "20261101T162100Z-abcdef1" in text
    assert "light build (`tag:feed_reports+ path:models/ops`)" in text
    assert "Queued 5.0 min, dbt 14.0 min, total 25.0 min" in text
    assert "| build | success | 14.0 min |" in text
    assert "| gold.fct_event | 900,000 |" in text


def test_main_writes_duckdb_and_prints_the_summary(tmp_path: Path, monkeypatch, capsys) -> None:  # type: ignore[no-untyped-def]
    target = artifacts(tmp_path)
    for key in ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("OUTCOME", "success")
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    db = tmp_path / "lake.duckdb"
    code = build_log.main(
        ["--engine", "duckdb", "--duckdb", str(db), "--target-dir", str(target), "--summary"]
    )
    assert code == 0
    out = capsys.readouterr().out
    assert "recorded build run local to ops.build_log" in out and "## Build lakehouse" in out
    con = duckdb.connect(str(db), read_only=True)
    try:
        assert con.execute("select count(*) from ops.build_log").fetchone() == (1,)
    finally:
        con.close()


def test_schedule_delay_measures_against_the_latest_cron_slot() -> None:
    crons = ((9, 27), (22, 41))
    assert build_log.schedule_delay(datetime(2026, 11, 2, 16, 4, tzinfo=UTC), crons) == 23820.0
    assert build_log.schedule_delay(datetime(2026, 11, 2, 1, 54, tzinfo=UTC), crons) == 11580.0
    assert build_log.schedule_delay(datetime(2026, 11, 2, 9, 27, tzinfo=UTC), crons) == 0.0
    assert build_log.schedule_delay(None, crons) is None
    assert build_log.schedule_delay(datetime(2026, 11, 2, 16, 4, tzinfo=UTC), ()) is None


def test_ingest_crons_are_read_from_the_workflow(tmp_path: Path) -> None:
    wf = tmp_path / "ingest.yml"
    wf.write_text(
        'on:\n  schedule:\n    - cron: "27 9 * * *"\n    - cron: "41 22 * * *" # evening\n',
        encoding="utf-8",
    )
    assert build_log.ingest_crons(wf) == ((9, 27), (22, 41))
    assert build_log.ingest_crons(tmp_path / "missing.yml") == build_log.INGEST_CRONS_FALLBACK


def test_collect_records_how_late_a_scheduled_trigger_fired(tmp_path: Path) -> None:
    target = artifacts(tmp_path)

    def api(path: str):  # type: ignore[no-untyped-def]
        if path.endswith("/runs/40"):
            return {"event": "schedule", "created_at": "2026-11-02T16:04:06Z"}
        return _api(path)

    record = build_log.collect(
        ENV, api=api, fetch_json=lambda _: MANIFEST, target_dirs=[target], now=NOW
    )
    assert record.schedule_delay_seconds is not None and record.schedule_delay_seconds > 0
    assert "after its cron" in build_log.summary_markdown(record)
    dispatched = build_log.collect(
        ENV, api=_api, fetch_json=lambda _: MANIFEST, target_dirs=[target], now=NOW
    )
    assert dispatched.schedule_delay_seconds is None
