"""YouTube channels (#851): the feed parser, the transcript fetch and its stop at any block, with
YouTube faked by a mock transport. The feed is built from the Atom spec and YouTube's namespaces,
the pages and captions from their shapes; none is a real channel's or a real transcript."""

from __future__ import annotations

import json
import random
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from ingest.http import CRAWLER_USER_AGENT, ThrottledClient
from ingest.land import ENDPOINT_DIRS, LandOptions, plan_lines
from ingest.run import RunSummary
from ingest.store import Landing, LocalBackend
from ingest.youtube import (
    CHANNELS_FILE,
    MAX_TRANSCRIPTS,
    THROTTLE,
    BlockedError,
    Channel,
    YoutubeIngestor,
    caption_url,
    chunk_id,
    chunk_lines,
    load_channels,
    parse_captions,
    parse_videos,
    player_response,
)

FIXTURES = Path(__file__).parent / "fixtures" / "youtube"
FEED = (FIXTURES / "channel_feed.xml").read_bytes()
CHANNEL = Channel(
    id="example-hoops",
    name="Example Hoops Talk",
    channel_id="UCexampleChannel0000001A",
    url="https://www.youtube.com/@ExampleHoopsTalk",
    league="nba",
    transcripts=True,
    terms="made up for the tests",
)
NOW = datetime(2026, 11, 8, 13, 0, tzinfo=UTC)
CAPTIONS_URL = "https://www.youtube.com/api/timedtext?v={v}&caps=asr&lang=en&signature=abc"
CURLY = chr(0x2019)


def player(video_id: str, **extra: Any) -> dict[str, Any]:
    """A watch page's player data, in the shape YouTube gives it."""
    tracks = [
        {
            "baseUrl": CAPTIONS_URL.format(v=video_id) + "&kind=asr",
            "languageCode": "fr",
            "kind": "asr",
        },
        {
            "baseUrl": CAPTIONS_URL.format(v=video_id) + "&kind=asr",
            "languageCode": "en",
            "kind": "asr",
        },
    ]
    return {
        "playabilityStatus": {"status": "OK"},
        "captions": {"playerCaptionsTracklistRenderer": {"captionTracks": tracks}},
        "videoDetails": {"videoId": video_id},
        **extra,
    }


def watch_page(data: dict[str, Any]) -> bytes:
    return (
        "<!DOCTYPE html><html><body><script>var ytInitialPlayerResponse = "
        + json.dumps(data)
        + ";var meta = document.createElement('meta');</script></body></html>"
    ).encode()


def json3(*lines: tuple[int, int, list[str]]) -> bytes:
    events: list[dict[str, Any]] = [{"tStartMs": 0, "dDurationMs": 900000, "id": 1}]
    for start, length, segs in lines:
        events.append(
            {"tStartMs": start, "dDurationMs": length, "segs": [{"utf8": s} for s in segs]}
        )
        events.append({"tStartMs": start + length, "aAppend": 1, "segs": [{"utf8": "\n"}]})
    return json.dumps({"wireMagic": "pb3", "events": events}).encode()


CAPTIONS = json3(
    (1200, 3400, ["so avery", " example is", " starting tonight"]),
    (4600, 2800, ["and jordan sample", " loses minutes"]),
)

# the feed's parser


def test_the_feed_gives_each_of_the_channels_videos_once() -> None:
    videos = parse_videos(FEED, CHANNEL.channel_id)
    assert [v["id"] for v in videos] == ["vid00000002", "vid00000003", "vid00000001"], (
        "another channel's video, a bad id and a repeat are left out"
    )
    assert videos[0] == {
        "id": "vid00000002",
        "title": "Avery Example Is Taking Over & Nobody Noticed",
        "description": "Avery Example moves into the starting lineup, and Jordan Sample loses"
        " minutes. #nba #fantasybasketball",
        "published": "2026-11-07T16:30:18+00:00",
        "link": "https://www.youtube.com/watch?v=vid00000002",
    }
    assert videos[2]["description"] is None
    assert "20748" not in json.dumps(videos), "view counts and ratings are not kept"


@pytest.mark.parametrize(
    "body",
    [
        b"<html><body>Before you continue to YouTube</body></html>",
        b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><feed/>',
        b'<?xml version="1.0"?><rss version="2.0"><channel/></rss>',
        b"x" * 3_000_000,
    ],
    ids=["a consent page", "entities", "rss", "too large"],
)
def test_anything_but_the_channels_atom_feed_is_refused(body: bytes) -> None:
    with pytest.raises(ValueError):
        parse_videos(body, CHANNEL.channel_id)


def test_the_config_lists_sporting_logically_with_transcripts() -> None:
    [channel] = [c for c in load_channels(CHANNELS_FILE) if c.id == "sporting-logically"]
    assert channel.channel_id == "UCR8s3egas481EMmOxr5fBmg"
    assert channel.league == "nba" and channel.transcripts
    assert channel.feed_url.endswith("/feeds/videos.xml?channel_id=UCR8s3egas481EMmOxr5fBmg")


def test_a_channel_without_its_decision_or_a_bad_id_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "channels.toml"
    path.write_text(
        '[[channel]]\nid = "Bad Id"\nname = "X"\nchannel_id = "UC123"\n'
        'url = "https://example.com/x"\nleague = "mlb"\ntranscripts = "yes"\n',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="id must be") as caught:
        load_channels(path)
    for part in (
        "channel_id must be",
        "url must be",
        "league must be",
        "transcripts must",
        "terms",
    ):
        assert part in str(caught.value)
    one = (
        '[[channel]]\nid = "a"\nname = "A"\nchannel_id = "UCexampleChannel0000001A"\n'
        'url = "https://www.youtube.com/@a"\nleague = "nba"\ntranscripts = false\nterms = "t"\n'
    )
    path.write_text(one * 2, encoding="utf-8")
    with pytest.raises(ValueError, match="used twice"):
        load_channels(path)


# the captions


def test_the_captions_are_timed_lines_of_plain_words() -> None:
    assert parse_captions(CAPTIONS) == [
        {"start": 1.2, "duration": 3.4, "text": "so avery example is starting tonight"},
        {"start": 4.6, "duration": 2.8, "text": "and jordan sample loses minutes"},
    ]


def test_the_transcript_is_chunked_by_half_minutes_in_order() -> None:
    lines = [
        {"start": 31.0, "duration": 2.5, "text": "and jordan sample"},
        {"start": 4.6, "duration": 2.8, "text": "is starting tonight"},
        {"start": 1.2, "duration": 3.4, "text": "so avery example "},
        {"start": 59.9, "duration": 4.0, "text": "loses minutes"},
        {"start": 95.0, "duration": 1.0, "text": "next"},
    ]
    assert chunk_lines(lines) == [
        {"start": 1, "end": 7.4, "text": "so avery example is starting tonight"},
        {"start": 31, "end": 63.9, "text": "and jordan sample loses minutes"},
        {"start": 95, "end": 96.0, "text": "next"},
    ], "a window of 30 seconds, its start the first line's, its end the last line's"
    assert chunk_id("vid0000000-t", 31) == "vid0000000-t-t31"
    assert chunk_lines([]) == []


def test_the_samples_transcript_chunks_are_the_ingests_own() -> None:
    doc = json.loads((FIXTURES / "sample_transcript.json").read_text(encoding="utf-8"))
    assert doc["chunks"] == chunk_lines(doc["lines"])


def test_the_uploaders_english_captions_come_before_the_automatic_ones() -> None:
    data = player("vid00000002")
    tracks = data["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
    tracks.append({"baseUrl": CAPTIONS_URL.format(v="vid00000002"), "languageCode": "en-US"})
    found = caption_url(data)
    assert found is not None
    assert "kind=asr" not in found[0] and found[1] == {"language": "en-US", "kind": "uploader"}
    tracks.pop()
    assert caption_url(data) == (tracks[1]["baseUrl"], {"language": "en", "kind": "automatic"})


def test_captions_elsewhere_than_youtubes_timedtext_are_not_followed() -> None:
    data = player("vid00000002")
    data["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"][1]["baseUrl"] = (
        "https://elsewhere.example/api/timedtext?v=vid00000002"
    )
    with pytest.raises(ValueError, match="not YouTube's timedtext"):
        caption_url(data)


def test_a_video_without_english_captions_has_none_yet() -> None:
    data = player("vid00000002")
    data["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"].pop()
    assert caption_url(data) is None
    assert caption_url({"playabilityStatus": {"status": "OK"}}) is None


@pytest.mark.parametrize(
    ("page", "match"),
    [
        (b"<html>Sign in to confirm you" + CURLY.encode() + b"re not a bot</html>", "bot check"),
        (b"<html><div class='g-recaptcha'></div></html>", "bot check"),
        (b"<html><form action='https://consent.youtube.com/save'></form></html>", "no player"),
    ],
)
def test_a_page_without_the_player_is_a_block(page: bytes, match: str) -> None:
    with pytest.raises(BlockedError, match=match):
        player_response(page.decode())


# the ingestor


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> ThrottledClient:
    return ThrottledClient(
        THROTTLE,
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def _run(
    tmp_path: Path,
    client: ThrottledClient,
    now: datetime = NOW,
    env: dict[str, str] | None = None,
    channels: list[Channel] | None = None,
) -> RunSummary:
    summary = RunSummary("youtube", "nba", "2026-27", now)
    landing = Landing(LocalBackend(tmp_path), ingest_date=now.date())
    YoutubeIngestor(
        client,
        landing,
        "nba",
        "2026-27",
        channels=[CHANNEL] if channels is None else channels,
        now=now,
        env={"RUNNER_ENVIRONMENT": "self-hosted"} if env is None else env,
    ).land_into(summary)
    assert not landing.flush()
    return summary


def youtube(
    seen: list[httpx.Request],
    *,
    watch: Callable[[str], httpx.Response] | None = None,
    captions: Callable[[str], httpx.Response] | None = None,
    feed: httpx.Response | None = None,
) -> Callable[[httpx.Request], httpx.Response]:
    """A fake www.youtube.com: the feed, watch pages and captions, each overridable."""

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        video = request.url.params.get("v", "")
        if path == "/feeds/videos.xml":
            return feed or httpx.Response(200, content=FEED)
        if path == "/watch":
            if watch is not None:
                return watch(video)
            return httpx.Response(200, content=watch_page(player(video)))
        if path == "/api/timedtext":
            if captions is not None:
                return captions(video)
            return httpx.Response(200, content=CAPTIONS)
        return httpx.Response(404)

    return handler


def _transcripts(tmp_path: Path) -> list[Path]:
    folder = tmp_path / "landing/youtube/transcripts"
    return sorted(
        p for p in folder.rglob("*.json") if not p.name.endswith(".meta.json") and p.name[0] != "_"
    )


def test_the_feed_and_each_new_videos_captions_land_one_identified_request_at_a_time(
    tmp_path: Path,
) -> None:
    seen: list[httpx.Request] = []
    summary = _run(tmp_path, _client(youtube(seen)))
    assert summary.ok and not summary.missing
    assert [(r.url.path, r.url.params.get("v")) for r in seen] == [
        ("/feeds/videos.xml", None),
        ("/watch", "vid00000002"),
        ("/api/timedtext", "vid00000002"),
        ("/watch", "vid00000003"),
        ("/api/timedtext", "vid00000003"),
    ], "newest first; the video older than a week is not asked"
    for request in seen:
        assert request.headers["user-agent"] == CRAWLER_USER_AGENT
        assert "cookie" not in request.headers
    assert seen[2].url.params["fmt"] == "json3"
    assert summary.landed == 3

    videos = tmp_path / "landing/youtube/videos/nba/2026-27/2026-11-08/example-hoops.json"
    body = json.loads(videos.read_text(encoding="utf-8"))
    assert body["channel"]["channel_id"] == CHANNEL.channel_id and len(body["videos"]) == 3
    assert videos.with_name("example-hoops.meta.json").exists()
    [first, second] = _transcripts(tmp_path)
    assert first.name == "example-hoops.vid00000002.json"
    doc = json.loads(first.read_text(encoding="utf-8"))
    assert doc["video"]["title"].startswith("Avery Example")
    assert doc["captions"] == {"language": "en", "kind": "automatic"}
    assert doc["lines"][0] == {
        "start": 1.2,
        "duration": 3.4,
        "text": "so avery example is starting tonight",
    }
    assert doc["chunks"] == [
        {
            "start": 1,
            "end": 7.4,
            "text": "so avery example is starting tonight and jordan sample loses minutes",
        }
    ]
    assert first.with_name("example-hoops.vid00000002.meta.json").exists()
    assert second.name == "example-hoops.vid00000003.json"


def test_a_second_run_the_same_day_asks_nothing_and_the_next_day_only_the_feed(
    tmp_path: Path,
) -> None:
    seen: list[httpx.Request] = []
    client = _client(youtube(seen))
    _run(tmp_path, client)
    asked = len(seen)
    again = _run(tmp_path, client)
    assert len(seen) == asked and again.skipped == 1 and again.landed == 0
    tomorrow = _run(tmp_path, client, datetime(2026, 11, 9, 13, tzinfo=UTC))
    assert [r.url.path for r in seen[asked:]] == ["/feeds/videos.xml"], (
        "the transcripts landed already"
    )
    assert tomorrow.unchanged == 1 and tomorrow.landed == 0
    assert not (tmp_path / "landing/youtube/videos/nba/2026-27/2026-11-09").exists()


def test_at_most_a_few_transcripts_a_run() -> None:
    landing = Landing(LocalBackend(Path("unused")), ingest_date=NOW.date())
    ingestor = YoutubeIngestor(_client(youtube([])), landing, "nba", "2026-27", now=NOW)
    many = [
        {"id": f"vid{n:08d}", "published": f"2026-11-0{n % 7 + 1}T12:00:00+00:00"}
        for n in range(12)
    ]
    wanted = ingestor.wanted(CHANNEL, many, NOW)
    assert len(wanted) == MAX_TRANSCRIPTS
    assert wanted[0] == "vid00000006", "newest first; the first of the month is past the week"


def _redirect(_: str) -> httpx.Response:
    return httpx.Response(302, headers={"Location": "https://consent.youtube.com/m?continue=x"})


def _bot_check(_: str) -> httpx.Response:
    data = {
        "playabilityStatus": {
            "status": "LOGIN_REQUIRED",
            "reason": f"Sign in to confirm you{CURLY}re not a bot",
        }
    }
    return httpx.Response(200, content=watch_page(data))


def _token(video: str) -> httpx.Response:
    data = player(video)
    for track in data["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]:
        track["baseUrl"] += "&exp=xpe"
    return httpx.Response(200, content=watch_page(data))


@pytest.mark.parametrize(
    ("watch", "captions", "reason"),
    [
        (lambda _: httpx.Response(429), None, "HTTP 429"),
        (lambda _: httpx.Response(403, content=b"<html>Forbidden</html>"), None, "HTTP 403"),
        (_redirect, None, "redirected to consent.youtube.com"),
        (
            lambda _: httpx.Response(
                200, content=b"<html>Our systems have detected unusual traffic</html>"
            ),
            None,
            "bot check",
        ),
        (_bot_check, None, "LOGIN_REQUIRED: Sign in to confirm you"),
        (_token, None, "proof-of-origin token (exp=xpe)"),
        (None, lambda _: httpx.Response(200, content=b""), "came back empty"),
        (None, lambda _: httpx.Response(429), "HTTP 429"),
        (None, lambda _: httpx.Response(403), "HTTP 403"),
    ],
)
def test_any_block_stops_the_transcripts_lands_nothing_and_never_fails_the_run(
    tmp_path: Path,
    watch: Callable[[str], httpx.Response] | None,
    captions: Callable[[str], httpx.Response] | None,
    reason: str,
) -> None:
    seen: list[httpx.Request] = []
    summary = _run(tmp_path, _client(youtube(seen, watch=watch, captions=captions)))
    assert summary.ok and not summary.failures, "a block is not a failure: the run exits 0"
    assert summary.landed == 1, "the feed still lands"
    [missing] = summary.missing
    assert missing.endpoint == "transcripts" and missing.key == "example-hoops.vid00000002"
    assert "blocked" in missing.reason and reason in missing.reason
    assert not _transcripts(tmp_path)
    assert all(r.url.params.get("v") != "vid00000003" for r in seen), "no later video is asked"
    assert sum(r.url.path == "/watch" for r in seen) == 1, "no retry, no workaround"


def test_a_video_without_captions_yet_or_unplayable_is_skipped_and_the_next_one_asked(
    tmp_path: Path,
) -> None:
    def watch(video: str) -> httpx.Response:
        if video == "vid00000002":
            return httpx.Response(200, content=watch_page({"playabilityStatus": {"status": "OK"}}))
        return httpx.Response(
            200,
            content=watch_page(
                {"playabilityStatus": {"status": "UNPLAYABLE", "reason": "Private"}}
            ),
        )

    seen: list[httpx.Request] = []
    summary = _run(tmp_path, _client(youtube(seen, watch=watch)))
    assert summary.ok
    assert [m.reason.split(":")[0] for m in summary.missing] == [
        "ValueError",
        "ValueError",
    ]
    assert "no English captions yet" in summary.missing[0].reason
    assert "UNPLAYABLE" in summary.missing[1].reason
    assert [r.url.params.get("v") for r in seen if r.url.path == "/watch"] == [
        "vid00000002",
        "vid00000003",
    ]
    assert not _transcripts(tmp_path)


def test_a_github_hosted_runner_never_asks_for_a_transcript(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    summary = _run(tmp_path, _client(youtube(seen)), env={"RUNNER_ENVIRONMENT": "github-hosted"})
    assert [r.url.path for r in seen] == ["/feeds/videos.xml"]
    assert summary.landed == 1 and "home runner only" in summary.missing[0].reason


def test_a_channel_without_transcripts_is_read_for_its_videos_only(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    quiet = Channel(**{**CHANNEL.__dict__, "transcripts": False})
    _run(tmp_path, _client(youtube(seen)), channels=[quiet])
    assert [r.url.path for r in seen] == ["/feeds/videos.xml"]


@pytest.mark.parametrize(
    "feed",
    [
        httpx.Response(403, content=b"<html>Forbidden</html>"),
        httpx.Response(302, headers={"Location": "https://consent.youtube.com/m"}),
        httpx.Response(200, content=b"<html>Before you continue</html>"),
    ],
)
def test_a_feed_that_fails_is_missing_asks_no_transcript_and_never_fails_the_run(
    tmp_path: Path, feed: httpx.Response
) -> None:
    seen: list[httpx.Request] = []
    summary = _run(tmp_path, _client(youtube(seen, feed=feed)))
    assert summary.ok and len(seen) == 1
    assert summary.missing[0].endpoint == "videos"
    assert not list(tmp_path.rglob("example-hoops*.json"))


def test_the_youtube_source_has_its_landing_directories_and_plan() -> None:
    assert ENDPOINT_DIRS["youtube"] == ("videos", "transcripts")
    lines = plan_lines(
        LandOptions("youtube", "nba"), "2026-27", date(2026, 11, 8), date(2026, 11, 8)
    )
    assert any("youtube_channels.toml" in line for line in lines)
    assert any("stopping at any bot check" in line for line in lines)
