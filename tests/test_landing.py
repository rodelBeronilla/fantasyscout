from datetime import UTC, date, datetime
from pathlib import PurePosixPath

import pytest

from ingest.landing import Sidecar, landing_key, payload_hash


def test_landing_key_matches_spec_layout() -> None:
    key = landing_key("stats", "leaguegamelog", "wnba", "2026", date(2026, 10, 26), "0022600001")
    assert key == PurePosixPath("landing/stats/leaguegamelog/wnba/2026/2026-10-26/0022600001.json")


def test_landing_key_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="unusable"):
        landing_key("stats", "..", "nba", "2025-26", date(2026, 1, 1), "x")


def test_landing_key_sanitises_separators() -> None:
    key = landing_key("stats", "box score/v3", "nba", "2025-26", date(2026, 1, 1), "a b")
    assert key.parts[2] == "box-score-v3"
    assert key.name == "a-b.json"


def test_sidecar_records_hash_and_size() -> None:
    body = b'{"resultSets": []}'
    side = Sidecar.for_response(
        url="https://stats.wnba.com/stats/leaguegamelog",
        params={"LeagueID": "10", "Season": "2026"},
        status=200,
        body=body,
        fetched_at=datetime(2026, 10, 26, 12, 0, tzinfo=UTC),
    )
    assert side.size_bytes == len(body)
    assert side.sha256 == payload_hash(body)
    assert side.sidecar_path(PurePosixPath("landing/x/y.json")) == PurePosixPath(
        "landing/x/y.meta.json"
    )
