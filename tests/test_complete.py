"""An incomplete game payload is never settled; a resettle sweep re-fetches recent games (#260)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx

from ingest import complete
from ingest.http import Throttle, ThrottledClient
from ingest.stats import StatsIngestor, StatsPlanner, games_in_window
from ingest.store import Landing, LocalBackend
from tests.test_stats import fixture
from tests.test_store import SCOPE, _land

FIXTURES = Path(__file__).parent / "fixtures"


def test_predicates_tell_a_whole_payload_from_a_half_written_one() -> None:
    box = fixture("boxscoretraditionalv3")
    assert complete.stats_box_complete(box)
    half = json.loads(box)
    half["boxScoreTraditional"]["awayTeam"]["players"] = []
    assert not complete.stats_box_complete(json.dumps(half).encode())
    assert not complete.stats_box_complete(b"{}") and not complete.stats_box_complete(b"not json")

    pbp = json.loads(fixture("playbyplayv3"))
    assert complete.stats_playbyplay_complete(json.dumps(pbp).encode())
    pbp["game"]["actions"] = []
    assert not complete.stats_playbyplay_complete(json.dumps(pbp).encode())

    assert complete.stats_rows_complete(fixture("shotchartdetail"))
    assert not complete.stats_rows_complete(b'{"resultSets": [{"headers": [], "rowSet": []}]}')

    summary = (FIXTURES / "espn" / "summary.json").read_bytes()
    assert complete.espn_summary_complete(summary)
    early = json.loads(summary)
    early["boxscore"]["players"][1]["statistics"] = []
    assert not complete.espn_summary_complete(json.dumps(early).encode())

    assert complete.is_complete(complete.STATS, "leaguegamelog", b"anything")
    assert not complete.is_complete(complete.STATS, "boxscoretraditionalv3", b"{}")


def test_an_incomplete_landing_is_never_settled(tmp_path: Path) -> None:
    played = date(2026, 10, 20)
    landing = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27))
    _land(landing, "whole", b"all there")
    landing.land(
        SCOPE,
        "half",
        b"[]",
        url="u",
        params={},
        status=200,
        fetched_at=datetime.now(UTC),
        complete=False,
    )
    landing.flush()
    later = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 28))
    assert later.settled(SCOPE, "whole", played)
    assert not later.settled(SCOPE, "half", played), "fetched again until a whole payload lands"
    # The flag is in the index, and an index written before it existed reads as complete.
    index = json.loads((tmp_path / "landing/stats/leaguegamelog/wnba/2026/_index.json").read_text())
    assert index["half"]["complete"] is False and index["whole"]["complete"] is True
    del index["whole"]["complete"]
    (tmp_path / "landing/stats/leaguegamelog/wnba/2026/_index.json").write_text(json.dumps(index))
    assert Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 29)).settled(
        SCOPE, "whole", played
    )


def test_a_resettle_sweep_refetches_recent_games_only(tmp_path: Path) -> None:
    landing = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 27))
    _land(landing, "g", b"x")
    landing.flush()
    sweep = Landing(
        LocalBackend(tmp_path), ingest_date=date(2026, 10, 28), resettle_since=date(2026, 10, 15)
    )
    assert not sweep.settled(SCOPE, "g", date(2026, 10, 20)), "a game in the sweep is fetched again"
    assert sweep.settled(SCOPE, "g", date(2026, 10, 1)), "an older game stays settled"


def test_a_half_written_box_score_is_fetched_again_after_the_settle_window(tmp_path: Path) -> None:
    planner = StatsPlanner("wnba", "2026")
    games = games_in_window(fixture("leaguegamelog"))
    target = games[0].game_id
    half = json.loads(fixture("boxscoretraditionalv3"))
    half["boxScoreTraditional"]["awayTeam"]["players"] = []
    serve_half = {"on": True}

    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        if name == "boxscoretraditionalv3" and serve_half["on"]:
            return httpx.Response(200, content=json.dumps(half).encode())
        return httpx.Response(200, content=fixture(name))

    def client() -> ThrottledClient:
        return ThrottledClient(
            Throttle(max_retries=0),
            transport=httpx.MockTransport(handler),
            sleep=lambda _: None,
            clock=lambda: 0.0,
        )

    # Day one, ten days after the games: the half-written box lands, flagged incomplete.
    day1 = games[0].game_date + timedelta(days=10)
    first = StatsIngestor(
        client(), Landing(LocalBackend(tmp_path), ingest_date=day1), planner
    ).run()
    assert first.ok
    index = json.loads(
        (tmp_path / "landing/stats/boxscoretraditionalv3/wnba/2026/_index.json").read_text()
    )
    assert index[target]["complete"] is False
    # Day two: the whole payload is served; the box is fetched again although the game is long
    # settled, and lands complete. The play-by-play, whole on day one, is left alone.
    serve_half["on"] = False
    second = StatsIngestor(
        client(), Landing(LocalBackend(tmp_path), ingest_date=day1 + timedelta(days=1)), planner
    ).run()
    assert second.ok
    index = json.loads(
        (tmp_path / "landing/stats/boxscoretraditionalv3/wnba/2026/_index.json").read_text()
    )
    assert index[target]["complete"] is True
    pbp = json.loads((tmp_path / "landing/stats/playbyplayv3/wnba/2026/_index.json").read_text())
    assert pbp[target]["checked_date"] == day1.isoformat(), (
        "a settled, whole payload is not fetched again"
    )
