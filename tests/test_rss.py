from __future__ import annotations

import json
import random
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from ingest.http import CRAWLER_USER_AGENT, Throttle, ThrottledClient
from ingest.land import ENDPOINT_DIRS, LandOptions, plan_lines
from ingest.rss import (
    FEEDS_FILE,
    SUMMARY_CHARS,
    Feed,
    RssIngestor,
    load_feeds,
    parse_feed,
)
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend

FIXTURES = Path(__file__).parent / "fixtures" / "rss"
RSS = (FIXTURES / "rss2.xml").read_bytes()
ATOM = (FIXTURES / "atom.xml").read_bytes()
NBA = Feed(
    id="hoops-nba",
    outlet="Example Hoops Desk",
    url="https://hoops.example/nba/rss.xml",
    league="nba",
    terms_url="https://hoops.example/terms",
    keep="headline+summary",
    terms="made up for the tests",
)
HEADLINES = Feed(
    id="beat-wings",
    outlet="Example Beat",
    url="https://beat.example/wings/feed",
    league="wnba",
    terms_url="https://beat.example/terms",
    keep="headline",
    terms="made up for the tests",
    team="DAL",
)


def test_rss_items_keep_the_headline_link_date_and_a_plain_summary() -> None:
    items = parse_feed(RSS, keep_summary=True)
    assert [i["id"] for i in items] == [
        "hoops-1001",
        "https://hoops.example/nba/jordan-sample-starts",
        "hoops-1003",
    ], "deduped by guid, the link standing in for a missing guid, untitled items skipped"
    first = items[0]
    assert first == {
        "id": "hoops-1001",
        "title": "Avery Example (ankle) ruled out Friday",
        "link": "https://hoops.example/nba/avery-example-ruled-out",
        "published": "2026-11-08T19:30:00+00:00",
        "summary": "The guard will not play against the Hawks & is day-to-day.",
    }
    assert items[1]["title"] == "Jordan Sample – moving into the starting lineup"  # noqa: RUF001
    assert items[1]["published"] == "2026-11-08T16:00:00+00:00", "dc:date stands in for pubDate"
    assert items[2]["link"] is None, "only a web link is kept"
    assert items[2]["published"] is None


def test_atom_entries_keep_the_alternate_link_and_the_summary_never_the_content() -> None:
    items = parse_feed(ATOM, keep_summary=True)
    assert items[0] == {
        "id": "urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a",
        "title": "Casey Placeholder's minutes restriction lifted",
        "link": "https://beat.example/wings/casey-minutes",
        "published": "2026-07-14T17:00:00+00:00",
        "summary": "The center is cleared for a full workload.",
    }
    assert items[1]["published"] == "2026-07-13T09:00:00+00:00", "updated stands in"
    assert items[1]["summary"] is None
    assert "whole story" not in json.dumps(items)


def test_a_headline_only_feed_keeps_no_summary() -> None:
    items = parse_feed(RSS, keep_summary=False)
    assert all("summary" not in i for i in items)


def test_a_long_summary_keeps_only_its_opening_cut_at_a_word() -> None:
    words = " ".join(f"word{i}" for i in range(400))
    body = (
        "<rss version='2.0'><channel><item><title>T</title><link>https://x.example/1</link>"
        f"<description>{words}</description></item></channel></rss>"
    ).encode()
    [item] = parse_feed(body, keep_summary=True)
    assert len(item["summary"]) <= SUMMARY_CHARS
    assert words.startswith(item["summary"]) and words[len(item["summary"])] == " "


@pytest.mark.parametrize(
    "body",
    [
        b"<!DOCTYPE html><html><body>Checking your browser</body></html>",
        b"<html><body><p>Just a moment...</p></body></html>",
        b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel/></rss>',
        b"not xml at all",
    ],
)
def test_anything_but_a_feed_is_refused(body: bytes) -> None:
    with pytest.raises(ValueError):
        parse_feed(body, keep_summary=True)


def test_the_config_lists_only_checked_feeds() -> None:
    feeds = load_feeds(FEEDS_FILE)
    assert feeds, "at least one feed is kept"
    for f in feeds:
        assert f.terms_url.startswith("https://") and f.url.startswith("https://")
        assert f.keep in ("headline", "headline+summary")
        assert f.league in ("nba", "wnba")


def test_a_feed_without_its_terms_or_a_bad_id_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "feeds.toml"
    path.write_text(
        '[[feed]]\nid = "Bad Id"\noutlet = "X"\nurl = "http://x.example/feed"\nleague = "nba"\n'
        'keep = "everything"\n',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="id must be") as caught:
        load_feeds(path)
    for part in ("keep must be", "url must be", "terms_url must be", "terms (what"):
        assert part in str(caught.value)
    twice = (
        '[[feed]]\nid = "a"\noutlet = "X"\nurl = "https://x.example/f"\nleague = "nba"\n'
        'terms_url = "https://x.example/t"\nkeep = "headline"\nterms = "open"\n'
    )
    path.write_text(twice * 2, encoding="utf-8")
    with pytest.raises(ValueError, match="used twice"):
        load_feeds(path)


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> ThrottledClient:
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def _run(
    tmp_path: Path,
    client: ThrottledClient,
    now: datetime,
    feeds: list[Feed],
    league: str = "nba",
    full_refresh: bool = False,
) -> RunSummary:
    summary = RunSummary("reports", league, "2026-27", now)  # type: ignore[arg-type]
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date(), full_refresh=full_refresh)
    RssIngestor(client, landing, league, "2026-27", feeds=feeds, now=now).land_into(summary)  # type: ignore[arg-type]
    assert not landing.flush()
    return summary


def test_one_identified_request_per_feed_and_hour_then_a_conditional_get(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(
            200,
            content=RSS,
            headers={"ETag": '"v1"', "Last-Modified": "Sat, 08 Nov 2026 19:00:00 GMT"},
        )

    client = _client(handler)
    morning = datetime(2026, 11, 8, 15, 5, tzinfo=UTC)  # 10 am Eastern
    first = _run(tmp_path, client, morning, [NBA, HEADLINES])
    assert len(seen) == 1, "only the league's feeds are asked"
    assert seen[0].headers["user-agent"] == CRAWLER_USER_AGENT
    assert "fantasyscout.beronilla.rodeo/sources" in seen[0].headers["user-agent"]
    assert "if-none-match" not in seen[0].headers
    assert first.landed == 1

    again = _run(tmp_path, client, morning, [NBA])
    assert len(seen) == 1, "the same hour does not ask again"
    assert again.skipped == 1 and again.landed == 0

    evening = datetime(2026, 11, 8, 23, 50, tzinfo=UTC)
    later = _run(tmp_path, client, evening, [NBA])
    assert len(seen) == 2
    assert seen[1].headers["if-none-match"] == '"v1"'
    assert seen[1].headers["if-modified-since"] == "Sat, 08 Nov 2026 19:00:00 GMT"
    assert later.unchanged == 1 and later.landed == 0

    folder = tmp_path / "landing/rss/items/nba/2026-27/2026-11-08"
    payloads = sorted(p.name for p in folder.glob("*.json") if not p.name.endswith(".meta.json"))
    assert payloads == ["hoops-nba.2026-11-08T10.json"]
    assert (folder / "hoops-nba.2026-11-08T10.meta.json").exists()
    body = json.loads((folder / payloads[0]).read_text(encoding="utf-8"))
    assert body["feed"]["terms_url"] == NBA.terms_url
    assert body["etag"] == '"v1"' and len(body["items"]) == 3
    assert "photo.jpg" not in json.dumps(body), "markup and images are dropped"


def test_a_feed_with_no_validators_lands_only_when_its_items_change(tmp_path: Path) -> None:
    bodies = [RSS, RSS, RSS.replace(b"ruled out Friday", b"ruled out Saturday")]
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=bodies[len(seen) - 1])

    client = _client(handler)
    hours = [datetime(2026, 11, 8, h, 0, tzinfo=UTC) for h in (15, 18, 23)]
    results = [_run(tmp_path, client, h, [NBA]) for h in hours]
    assert [r.landed for r in results] == [1, 0, 1]
    assert results[1].unchanged == 1
    folder = tmp_path / "landing/rss/items/nba/2026-27/2026-11-08"
    assert len([p for p in folder.glob("*.json") if not p.name.endswith(".meta.json")]) == 2
    index = json.loads((tmp_path / "landing/rss/items/nba/2026-27/_index.json").read_text())
    assert sorted(index) == ["hoops-nba.2026-11-08T10", "hoops-nba.2026-11-08T18"]


def test_a_full_refresh_asks_without_validators_and_lands(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=RSS, headers={"ETag": '"v1"'})

    client = _client(handler)
    _run(tmp_path, client, datetime(2026, 11, 8, 15, tzinfo=UTC), [NBA])
    refreshed = _run(
        tmp_path, client, datetime(2026, 11, 8, 18, tzinfo=UTC), [NBA], full_refresh=True
    )
    assert "if-none-match" not in seen[1].headers
    assert refreshed.landed == 1


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (httpx.Response(403, content=b"<html>blocked</html>"), "HTTP 403"),
        (
            httpx.Response(301, headers={"Location": "https://hoops.example/new.xml"}),
            "moved to https://hoops.example/new.xml",
        ),
        (httpx.Response(200, content=b"<html><body>Just a moment</body></html>"), "not an RSS"),
        (httpx.Response(304), "HTTP 304"),
    ],
)
def test_a_feed_that_fails_is_missing_and_never_fails_the_run(
    tmp_path: Path, response: httpx.Response, reason: str
) -> None:
    client = _client(lambda _: response)
    summary = _run(tmp_path, client, datetime(2026, 11, 8, 15, tzinfo=UTC), [NBA, NBA])
    assert summary.ok and not summary.failures
    assert len(summary.missing) == 2 and reason in summary.missing[0].reason
    assert not list(tmp_path.rglob("hoops-nba*.json"))


def test_a_timeout_is_missing_too(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    summary = _run(tmp_path, _client(handler), datetime(2026, 11, 8, 15, tzinfo=UTC), [NBA])
    assert summary.ok and "IngestHTTPError" in summary.missing[0].reason


def test_the_rss_source_has_its_landing_directory_and_plan() -> None:
    assert ENDPOINT_DIRS["rss"] == ("items",)
    from datetime import date

    lines = plan_lines(LandOptions("rss", "nba"), "2026-27", date(2026, 11, 8), date(2026, 11, 8))
    assert any("rss_feeds.toml" in line for line in lines)
    reports = plan_lines(
        LandOptions("reports", "nba"), "2026-27", date(2026, 11, 8), date(2026, 11, 8)
    )
    assert any("RSS feeds" in line for line in reports)
