"""YouTube channels' videos and their caption transcripts (#812, #851): what an analyst says,
dated and credited, for the claims.

The channels are listed in ``ingest/youtube_channels.toml`` on the owner's decision (ADR 0008,
addendum of 2026-11-08). A run, once a day on the home runner, does two things per channel:

- **Videos.** One request for the channel's public Atom feed
  (``/feeds/videos.xml?channel_id=<id>``, no key): each video's id, title, description (cut to
  ``DESCRIPTION_CHARS``) and publish time. View counts and ratings are not kept. The feed lands
  under ``landing/youtube/videos/<league>/<season>/<date>/<channel>.json`` when its videos differ
  from the last landing; a second run the same day asks nothing.
- **Transcripts**, where the channel allows them in the file: for each video published in the
  last ``TRANSCRIPT_DAYS`` days whose transcript has not landed, at most ``MAX_TRANSCRIPTS`` a
  run, newest first, one video at a time and seconds apart: the watch page, for its caption
  list, then the English captions (the uploader's own before the automatic ones). One file per
  video under ``landing/youtube/transcripts/<league>/<season>/<date>/<channel>.<video>.json``,
  the timed lines as YouTube gives them, and the same lines in half-minute chunks
  (``chunk_lines``), the items the claims extractor reads.

The client says who it is (``CRAWLER_USER_AGENT``), keeps no cookie, follows no redirect and
never retries. The transcripts stop at the first sign that YouTube is checking the client
(``BlockedError``): HTTP 429 or 403, a redirect (to a consent, captcha or sign-in page), a page with
no player in it, "Sign in to confirm you're not a bot" (``LOGIN_REQUIRED``), or captions that ask
for a proof-of-origin token. Nothing lands for that video, no later video is asked, the reason is
recorded as missing in the run log and the run exits 0. Nothing is tried to get past it: no
token, no cookie or account, no other client, no proxy service. A GitHub-hosted runner never
asks for a transcript (``RUNNER_ENVIRONMENT``). The transcripts are never published; only the
claims the local model derives from them are used (ai/claims.py).
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree as ET

import httpx

from ingest.http import CRAWLER_USER_AGENT, IngestHTTPError, Throttle, ThrottledClient
from ingest.landing import League
from ingest.rss import MAX_BYTES as FEED_MAX_BYTES
from ingest.rss import _children, _cut, _instant, _local, _text
from ingest.run import RunSummary
from ingest.store import Landing, LandResult, Scope

SOURCE = "youtube"
VIDEOS = "videos"
TRANSCRIPTS = "transcripts"
CHANNELS_FILE = Path(__file__).resolve().parent / "youtube_channels.toml"
HOST = "www.youtube.com"
FEED_URL = f"https://{HOST}/feeds/videos.xml"
WATCH_URL = f"https://{HOST}/watch"
# One request at a time to the one host, five to ten seconds apart, and never a retry.
THROTTLE = Throttle(min_gap=5.0, max_gap=10.0, start_gap=6.0, max_retries=0, timeout=20.0)
HEADERS = {"User-Agent": CRAWLER_USER_AGENT, "Accept-Language": "en"}
MAX_VIDEOS = 50
DESCRIPTION_CHARS = 2000
TITLE_CHARS = 300
TRANSCRIPT_DAYS = 7
MAX_TRANSCRIPTS = 5
MAX_PAGE_BYTES = 8_000_000
MAX_SEGMENTS = 5000
# what the claims extractor reads as one item: half a minute of speech (chunk_lines)
CHUNK_SECONDS = 30

YT_NS = "{http://www.youtube.com/xml/schemas/2015}"
_SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_CHANNEL_ID = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ENTITY = re.compile(rb"<!ENTITY", re.I)
_SPACE = re.compile(r"\s+")
PLAYER = "var ytInitialPlayerResponse = "
# what YouTube's checks say, in a page that carries no player (straight or curly apostrophe)
BOT_CHECK = re.compile(r"confirm you.?re not a bot|g-recaptcha|unusual traffic", re.I)


class BlockedError(Exception):
    """YouTube is checking or refusing the client: stop asking, try nothing else."""


@dataclass(frozen=True)
class Channel:
    """One channel, and whether its new videos' transcripts are fetched."""

    id: str
    name: str
    channel_id: str
    url: str
    league: League
    transcripts: bool
    terms: str

    @property
    def feed_url(self) -> str:
        return f"{FEED_URL}?channel_id={self.channel_id}"


def _channel(raw: dict[str, Any]) -> Channel:
    channel = Channel(
        id=str(raw.get("id", "")),
        name=str(raw.get("name", "")),
        channel_id=str(raw.get("channel_id", "")),
        url=str(raw.get("url", "")),
        league=raw.get("league", ""),
        transcripts=raw.get("transcripts") is True,
        terms=str(raw.get("terms", "")),
    )
    problems = []
    if not _SLUG.match(channel.id):
        problems.append("id must be lower-case words joined by hyphens")
    if not channel.name:
        problems.append("name is required")
    if not _CHANNEL_ID.match(channel.channel_id):
        problems.append("channel_id must be YouTube's (UC and 22 characters)")
    if not channel.url.startswith(f"https://{HOST}/"):
        problems.append(f"url must be on https://{HOST}/")
    if channel.league not in ("nba", "wnba"):
        problems.append("league must be nba or wnba")
    if not isinstance(raw.get("transcripts"), bool):
        problems.append("transcripts must be true or false")
    if not channel.terms:
        problems.append("terms (the decision this channel is read on) is required")
    if problems:
        msg = f"youtube channel {channel.id or '?'}: " + "; ".join(problems)
        raise ValueError(msg)
    return channel


def load_channels(path: Path = CHANNELS_FILE) -> tuple[Channel, ...]:
    """The channels the file lists, checked."""
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    channels = tuple(_channel(raw) for raw in data.get("channel", []))
    ids = [c.id for c in channels]
    if dupes := sorted({i for i in ids if ids.count(i) > 1}):
        msg = f"youtube channel ids used twice: {', '.join(dupes)}"
        raise ValueError(msg)
    return channels


def _description(entry: ET.Element) -> str:
    for group in _children(entry, "group"):
        for desc in _children(group, "description"):
            return _text(desc)
    return ""


def parse_videos(body: bytes, channel_id: str) -> list[dict[str, Any]]:
    """The channel feed's videos: id, title, description, publish time and watch link.

    Only the channel's own videos (each entry names its channel), each once, at most
    ``MAX_VIDEOS``. Raises ValueError for anything that is not the channel's Atom feed.
    """
    if len(body) > FEED_MAX_BYTES:
        msg = f"{len(body)} bytes, more than a feed's {FEED_MAX_BYTES}"
        raise ValueError(msg)
    if _ENTITY.search(body):
        msg = "the document declares entities, which no feed needs"
        raise ValueError(msg)
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        msg = f"not XML ({e})"
        raise ValueError(msg) from e
    if _local(root.tag) != "feed":
        msg = f"not an Atom feed (root <{_local(root.tag)}>)"
        raise ValueError(msg)
    videos: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in _children(root, "entry"):
        video_id = (entry.findtext(f"{YT_NS}videoId") or "").strip()
        owner = (entry.findtext(f"{YT_NS}channelId") or channel_id).strip()
        title = _cut(_text(next(_children(entry, "title"), None)), TITLE_CHARS)
        published = _instant(_text(next(_children(entry, "published"), None)))
        if not _VIDEO_ID.match(video_id) or owner != channel_id or not title or video_id in seen:
            continue
        seen.add(video_id)
        videos.append(
            {
                "id": video_id,
                "title": title,
                "description": _cut(_description(entry), DESCRIPTION_CHARS) or None,
                "published": published,
                "link": f"{WATCH_URL}?v={video_id}",
            }
        )
        if len(videos) >= MAX_VIDEOS:
            break
    return videos


# the transcripts


def check_response(response: httpx.Response) -> None:
    """Raise Blocked when the answer is YouTube refusing or checking the client, ValueError when
    it is some other failure for this video alone."""
    status = response.status_code
    if status in (403, 429):
        raise BlockedError(f"HTTP {status}")
    if 300 <= status < 400:
        where = urlsplit(response.headers.get("location", "")).netloc or "elsewhere"
        raise BlockedError(
            f"HTTP {status}, redirected to {where} (a consent, captcha or sign-in page)"
        )
    if status != 200:
        msg = f"HTTP {status}"
        raise ValueError(msg)


def player_response(page: str) -> dict[str, Any]:
    """The player data a watch page carries. A page without it is a check page: BlockedError."""
    at = page.find(PLAYER)
    if at < 0:
        if m := BOT_CHECK.search(page):
            raise BlockedError(f"a bot check: {m.group(0)!r}")
        raise BlockedError("the watch page carries no player (a consent or check page)")
    try:
        data, _ = json.JSONDecoder().raw_decode(page, at + len(PLAYER))
    except ValueError as e:
        raise BlockedError(f"the watch page's player is unreadable ({e})") from e
    if not isinstance(data, dict):
        raise BlockedError("the watch page's player is not an object")
    return data


def caption_url(player: dict[str, Any]) -> tuple[str, dict[str, str]] | None:
    """The English captions' address and what they are; None when the video has none yet.

    Raises BlockedError when YouTube wants a sign-in ("confirm you're not a bot") or a
    proof-of-origin token for the captions, ValueError when the video cannot be played at all.
    """
    playability = player.get("playabilityStatus") or {}
    status = str(playability.get("status", ""))
    reason = str(playability.get("reason", ""))
    if status == "LOGIN_REQUIRED" or BOT_CHECK.search(reason):
        raise BlockedError(f"{status or 'a check'}: {reason or 'sign-in required'}")
    if status != "OK":
        msg = f"not playable: {status} {reason}".strip()
        raise ValueError(msg)
    renderer = (player.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}
    tracks = [t for t in renderer.get("captionTracks") or [] if isinstance(t, dict)]
    english = [t for t in tracks if str(t.get("languageCode", "")).split("-")[0] == "en"]
    if not english:
        return None
    # the uploader's own captions before the automatic ones, plain "en" before a regional one
    track = min(english, key=lambda t: (t.get("kind") == "asr", t.get("languageCode") != "en"))
    url = str(track.get("baseUrl", ""))
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != HOST or parts.path != "/api/timedtext":
        msg = f"the caption address is not YouTube's timedtext ({parts.netloc}{parts.path})"
        raise ValueError(msg)
    if "xpe" in parse_qs(parts.query).get("exp", []):
        raise BlockedError(
            "the captions ask for a proof-of-origin token (exp=xpe), which is not generated here"
        )
    about = {
        "language": str(track.get("languageCode")),
        "kind": "automatic" if track.get("kind") == "asr" else "uploader",
    }
    return url, about


def parse_captions(body: bytes) -> list[dict[str, Any]]:
    """YouTube's timed captions (json3) as lines: start and length in seconds, and the words.

    An empty answer is YouTube withholding them (it wants a token): BlockedError.
    """
    if not body.strip():
        raise BlockedError("the captions came back empty (YouTube wants a proof-of-origin token)")
    try:
        data = json.loads(body)
    except ValueError as e:
        msg = f"the captions are not JSON ({e})"
        raise ValueError(msg) from e
    lines: list[dict[str, Any]] = []
    for event in data.get("events") or []:
        segs = event.get("segs") if isinstance(event, dict) else None
        if not segs:
            continue
        text = _SPACE.sub(" ", "".join(str(s.get("utf8", "")) for s in segs)).strip()
        if not text:
            continue
        lines.append(
            {
                "start": round(int(event.get("tStartMs", 0)) / 1000, 2),
                "duration": round(int(event.get("dDurationMs", 0)) / 1000, 2),
                "text": text,
            }
        )
        if len(lines) >= MAX_SEGMENTS:
            break
    return lines


def chunk_lines(lines: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The transcript in chunks, the items the claims extractor reads: the lines of each
    ``CHUNK_SECONDS`` window joined in order, each chunk starting (whole seconds) at its first
    line and ending where its last line does. Automatic captions carry no sentences to cut at, so
    the windows are of time; a chunk is short, and its start says where to hear it again."""
    windows: dict[int, list[dict[str, Any]]] = {}
    for line in sorted(lines, key=lambda line: float(line["start"])):
        windows.setdefault(int(float(line["start"]) // CHUNK_SECONDS), []).append(line)
    return [
        {
            "start": int(float(group[0]["start"])),
            "end": round(max(float(x["start"]) + float(x.get("duration") or 0) for x in group), 2),
            "text": " ".join(str(x["text"]).strip() for x in group),
        }
        for _, group in sorted(windows.items())
    ]


def chunk_id(video_id: str, start: int) -> str:
    """A chunk's id, the claims' source_id: the video and the chunk's start in seconds."""
    return f"{video_id}-t{start}"


def transcript_key(channel_id: str, video_id: str) -> str:
    """The landing key: the channel (FantasyScout's id for it) and the video; ids hold no dot."""
    return f"{channel_id}.{video_id}"


def on_github_hosted_runner(env: Mapping[str, str]) -> bool:
    return env.get("RUNNER_ENVIRONMENT", "") == "github-hosted"


@dataclass
class YoutubeIngestor:
    """Lands the league's channels' videos and new transcripts into an existing run summary."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    channels: Sequence[Channel] | None = None
    now: datetime | None = None
    env: Mapping[str, str] | None = None

    def land_into(self, summary: RunSummary) -> None:
        now = self.now or datetime.now(UTC)
        channels = load_channels() if self.channels is None else self.channels
        for channel in channels:
            if channel.league != self.league:
                continue
            videos = self._land_videos(channel, now, summary)
            if videos is not None and channel.transcripts:
                self._land_transcripts(channel, videos, now, summary)

    def _scope(self, endpoint: str) -> Scope:
        return Scope(SOURCE, endpoint, self.league, self.season)

    def _land_videos(
        self, channel: Channel, now: datetime, summary: RunSummary
    ) -> list[dict[str, Any]] | None:
        """The feed's videos, landed when they changed; None when the feed was not read."""
        scope = self._scope(VIDEOS)
        key = channel.id
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)  # today's run already asked, for the transcripts too
                return None
            response = self.client.get(channel.feed_url, headers=HEADERS)
            check_response(response)
            videos = parse_videos(response.content, channel.channel_id)
            previous = self.landing.read_latest(scope, key)
            if previous and json.loads(previous).get("videos") == videos:
                body = previous  # the same bytes: confirmed today, nothing written
            else:
                doc = {"channel": asdict(channel), "fetched_at": now.isoformat(), "videos": videos}
                body = json.dumps(doc, ensure_ascii=False, indent=1).encode("utf-8")
            result = self.landing.land(
                scope,
                key,
                body,
                url=channel.feed_url,
                params={},
                status=200,
                fetched_at=now,
            )
            summary.record(result)
            return videos
        except Exception as exc:  # a channel's feed failing never fails the run
            summary.miss(VIDEOS, key, f"{type(exc).__name__}: {exc}"[:300])
            return None

    def wanted(
        self, channel: Channel, videos: Sequence[dict[str, Any]], now: datetime
    ) -> list[str]:
        """The videos whose transcripts this run asks for: recent, not landed, newest first."""
        since = now - timedelta(days=TRANSCRIPT_DAYS)
        scope = self._scope(TRANSCRIPTS)
        recent = [
            v
            for v in videos
            if v["published"]
            and datetime.fromisoformat(v["published"]) >= since
            and not self.landing.has_landed(scope, transcript_key(channel.id, v["id"]))
        ]
        recent.sort(key=lambda v: v["published"], reverse=True)
        return [v["id"] for v in recent[:MAX_TRANSCRIPTS]]

    def _land_transcripts(
        self,
        channel: Channel,
        videos: Sequence[dict[str, Any]],
        now: datetime,
        summary: RunSummary,
    ) -> None:
        wanted = self.wanted(channel, videos, now)
        if not wanted:
            return
        if on_github_hosted_runner(self.env if self.env is not None else os.environ):
            summary.miss(
                TRANSCRIPTS,
                channel.id,
                "not asked: transcripts are fetched on the home runner only",
            )
            return
        by_id = {v["id"]: v for v in videos}
        for video_id in wanted:
            key = transcript_key(channel.id, video_id)
            try:
                result = self._land_transcript(channel, by_id[video_id], key, now)
            except BlockedError as stop:
                summary.miss(
                    TRANSCRIPTS,
                    key,
                    f"blocked, the transcripts stop for this run: {stop}"[:300],
                )
                return
            except IngestHTTPError as exc:  # 429 under no retry, or the host unreachable
                if exc.last == "HTTP 429":
                    summary.miss(TRANSCRIPTS, key, "blocked, the transcripts stop: HTTP 429")
                else:
                    summary.miss(
                        TRANSCRIPTS, key, f"unreachable, the transcripts stop: {exc}"[:300]
                    )
                return
            except Exception as exc:  # this video alone: the next one is still asked
                summary.miss(TRANSCRIPTS, key, f"{type(exc).__name__}: {exc}"[:300])
                continue
            summary.record(result)

    def _land_transcript(
        self, channel: Channel, video: dict[str, Any], key: str, now: datetime
    ) -> LandResult:
        page = self.client.get(WATCH_URL, params={"v": video["id"]}, headers=HEADERS)
        check_response(page)
        if len(page.content) > MAX_PAGE_BYTES:
            msg = f"the watch page is {len(page.content)} bytes"
            raise ValueError(msg)
        found = caption_url(player_response(page.text))
        if found is None:
            msg = "no English captions yet: asked again on the next run while the video is new"
            raise ValueError(msg)
        url, about = found
        # the address carries its own signed query: the format is added to it, not put in its place
        captions = self.client.get(f"{url}&fmt=json3", headers=HEADERS)
        check_response(captions)
        lines = parse_captions(captions.content)
        if not lines:
            msg = "the captions hold no words"
            raise ValueError(msg)
        doc = {
            "channel": asdict(channel),
            "video": {k: video[k] for k in ("id", "title", "published", "link")},
            "captions": about,
            "fetched_at": now.isoformat(),
            "lines": lines,
            "chunks": chunk_lines(lines),
        }
        return self.landing.land(
            self._scope(TRANSCRIPTS),
            key,
            json.dumps(doc, ensure_ascii=False, indent=1).encode("utf-8"),
            url=f"{WATCH_URL}?v={video['id']}",
            params={},
            status=200,
            fetched_at=now,
        )


def land_channels(
    landing: Landing, league: League, season: str, summary: RunSummary, env: Mapping[str, str]
) -> None:
    """The league's channels, through their own client: no retries, the crawler's User-Agent."""
    with ThrottledClient(THROTTLE, headers=HEADERS) as client:
        YoutubeIngestor(client, landing, league, season, env=env).land_into(summary)
        for host, stats in client.pacing().items():
            summary.pacing[host] = stats
