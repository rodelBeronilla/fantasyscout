from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ingest.espn_news import EspnNewsIngestor, trim_articles
from ingest.http import Throttle, ThrottledClient
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend

ARTICLE = {
    "id": 46969411,
    "type": "HeadlineNews",
    "headline": "Knicks' Jose Alvarado (ankle) to miss fourth straight vs. 76ers",
    "description": "Licensed story text that must not be landed.",
    "published": "2026-10-30T01:22:00Z",
    "images": [{"url": "https://a.espncdn.invalid/photo.jpg"}],
    "byline": "A Reporter",
    "links": {"web": {"href": "https://www.espn.com/nba/story/_/id/46969411"}},
    "categories": [
        {"type": "league", "description": "NBA"},
        {"type": "team", "teamId": 18},
        {"type": "athlete", "athleteId": 4277869, "description": "Jose Alvarado"},
    ],
}


def test_an_article_keeps_the_headline_date_link_and_athletes_only() -> None:
    [article] = trim_articles(json.dumps({"articles": [ARTICLE]}).encode())
    assert article == {
        "id": 46969411,
        "type": "HeadlineNews",
        "headline": ARTICLE["headline"],
        "published": "2026-10-30T01:22:00Z",
        "url": "https://www.espn.com/nba/story/_/id/46969411",
        "athletes": [{"id": 4277869, "name": "Jose Alvarado"}],
    }


def test_the_news_lands_once_per_eastern_hour_without_the_story(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=json.dumps({"articles": [ARTICLE]}).encode())

    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    now = datetime(2026, 10, 30, 1, 30, tzinfo=UTC)  # 9:30 pm Eastern on the 29th
    for _ in range(2):
        summary = RunSummary("reports", "nba", "2026-27", now)
        landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
        EspnNewsIngestor(client, landing, "nba", "2026-27", now=now).land_into(summary)
        landing.flush()
    assert len(seen) == 1, "once per hour"
    assert seen[0].url.path == "/apis/site/v2/sports/basketball/nba/news"
    landed = next((tmp_path / "landing/espn/news/nba/2026-27").rglob("2026-10-29T21.json"))
    body = landed.read_text(encoding="utf-8")
    assert "Licensed story" not in body and "espncdn" not in body and "A Reporter" not in body
    assert json.loads(body)["articles"][0]["athletes"][0]["id"] == 4277869


def test_a_failed_feed_is_recorded_and_does_not_raise(tmp_path: Path) -> None:
    client = ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(lambda _: httpx.Response(404)),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )
    now = datetime(2026, 10, 30, 13, tzinfo=UTC)
    summary = RunSummary("reports", "wnba", "2026", now)
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    EspnNewsIngestor(client, landing, "wnba", "2026", now=now).land_into(summary)
    assert summary.failures
