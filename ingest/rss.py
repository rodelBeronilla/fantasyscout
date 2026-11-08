"""Outlets' and beat writers' published RSS and Atom feeds (#812): headlines, dated and credited.

Every feed in ``ingest/rss_feeds.toml`` was kept after its outlet's terms and robots.txt were read
(ADR 0008, addendum of 2026-11-08). The file records each feed's terms and what may be kept from
it: the headline alone, or the headline and the feed's own short summary. Feeds behind a login, a
paywall or an anti-bot challenge are not in it.

A run asks each of the league's feeds once: no retry, a User-Agent that names FantasyScout and its
Sources page, and the validators of the feed's last landing (``If-None-Match``,
``If-Modified-Since``), so an unchanged feed answers 304 and nothing is written. A redirect is not
followed: the file names each feed's own address. The items are parsed (RSS 2.0, RSS 1.0 or Atom)
to their id, headline, link and publish time, plus the summary where the terms allow it, cut to
``SUMMARY_CHARS``. The linked articles are never fetched.

A feed lands under ``landing/rss/items/<league>/<season>/<date>/<feed_id>.<date>T<hour>.json``,
once per Eastern hour, as the ESPN headlines do, and only when its items differ from the feed's
last landing. A file is never rewritten in place, which an incremental bronze model would miss.
A feed that is down, moved or no longer a feed is recorded as missing in the run log. It never
fails the run: one outlet's outage is not an incident.
"""

from __future__ import annotations

import html
import json
import re
import tomllib
from collections.abc import Iterator, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from xml.etree import ElementTree as ET

from ingest.http import CRAWLER_USER_AGENT, Throttle, ThrottledClient
from ingest.landing import EASTERN, League
from ingest.run import RunSummary
from ingest.store import Landing, LandResult, Scope

SOURCE = "rss"
ENDPOINT = "items"
FEEDS_FILE = Path(__file__).resolve().parent / "rss_feeds.toml"
# One request per feed per run: no retry, and a shorter wait than the stats API's.
THROTTLE = Throttle(max_retries=0, timeout=20.0)
ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8"
MAX_BYTES = 2_000_000
MAX_ITEMS = 100
# A feed's summary is its own teaser. Some feeds put the whole story there, so only its opening
# is kept, cut at a word, never the full text.
SUMMARY_CHARS = 400
TITLE_CHARS = 300

Keep = Literal["headline", "headline+summary"]
KEEPS: tuple[str, ...] = ("headline", "headline+summary")
_ID = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_TAG = re.compile(r"<[^>]*>")
_SPACE = re.compile(r"\s+")
_ENTITY = re.compile(rb"<!ENTITY", re.I)
DC_DATE = "{http://purl.org/dc/elements/1.1/}date"


@dataclass(frozen=True)
class Feed:
    """One published feed and what its terms let us keep."""

    id: str
    outlet: str
    url: str
    league: League
    terms_url: str
    keep: Keep
    # why the terms allow it, and why that much is kept: the decision, landed with every payload
    terms: str = ""
    team: str | None = None

    @property
    def keeps_summary(self) -> bool:
        return self.keep == "headline+summary"


def _feed(raw: dict[str, Any]) -> Feed:
    feed = Feed(
        id=str(raw.get("id", "")),
        outlet=str(raw.get("outlet", "")),
        url=str(raw.get("url", "")),
        league=raw.get("league", ""),
        terms_url=str(raw.get("terms_url", "")),
        keep=raw.get("keep", ""),
        terms=str(raw.get("terms", "")),
        team=raw.get("team") or None,
    )
    problems = []
    if not _ID.match(feed.id):
        problems.append("id must be lower-case words joined by hyphens")
    if not feed.outlet:
        problems.append("outlet is required")
    if not feed.terms:
        problems.append("terms (what the terms allow, and why) is required")
    if feed.league not in ("nba", "wnba"):
        problems.append("league must be nba or wnba")
    if feed.keep not in KEEPS:
        problems.append(f"keep must be one of {', '.join(KEEPS)}")
    for name in ("url", "terms_url"):
        if not getattr(feed, name).startswith("https://"):
            problems.append(f"{name} must be an https:// address")
    if problems:
        msg = f"rss feed {feed.id or '?'}: " + "; ".join(problems)
        raise ValueError(msg)
    return feed


def load_feeds(path: Path = FEEDS_FILE) -> tuple[Feed, ...]:
    """The feeds the file lists, checked: each has an id, an https address and its terms."""
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    feeds = tuple(_feed(raw) for raw in data.get("feed", []))
    ids = [f.id for f in feeds]
    if dupes := sorted({i for i in ids if ids.count(i) > 1}):
        msg = f"rss feed ids used twice: {', '.join(dupes)}"
        raise ValueError(msg)
    return feeds


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(el: ET.Element, name: str) -> Iterator[ET.Element]:
    return (c for c in el if _local(c.tag) == name)


def _text(el: ET.Element | None) -> str:
    """An element's text as plain words: markup dropped, entities read, spaces collapsed."""
    if el is None:
        return ""
    raw = "".join(el.itertext())
    return _SPACE.sub(" ", html.unescape(_TAG.sub(" ", raw))).strip()


def _cut(text: str, limit: int) -> str:
    """The text's opening, at most ``limit`` characters, cut at a word."""
    if len(text) <= limit:
        return text
    head = text[:limit]
    return head[: head.rfind(" ")] if " " in head else head


def _instant(text: str) -> str | None:
    """An RSS (RFC 822) or Atom (ISO 8601) date as UTC ISO text; None when unreadable."""
    value = text.strip()
    if not value:
        return None
    moment: datetime | None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        try:
            moment = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            moment = None
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat()


def _web_link(value: str) -> str | None:
    link = value.strip()
    return link if link.startswith(("https://", "http://")) else None


def _rss_item(el: ET.Element) -> dict[str, Any]:
    # the item's own <link>, not an atom:link a feed adds beside it
    link = el.find("link")
    if link is None:
        link = next(_children(el, "link"), None)
    guid = el.find("guid")
    if guid is None:
        guid = next(_children(el, "identifier"), None)
    date = el.find("pubDate")
    if date is None:
        date = el.find(DC_DATE)
    summary = el.find("description")
    return {
        "id": _text(guid),
        "title": _text(el.find("title")) or _text(next(_children(el, "title"), None)),
        "link": _web_link(_text(link)),
        "published": _instant(_text(date)),
        "summary": _text(
            summary if summary is not None else next(_children(el, "description"), None)
        ),
    }


def _atom_entry(el: ET.Element) -> dict[str, Any]:
    href = None
    for link in _children(el, "link"):
        if link.get("rel", "alternate") == "alternate" and link.get("href"):
            href = link.get("href", "")
            break
    date = next(_children(el, "published"), None)
    if date is None:
        date = next(_children(el, "updated"), None)
    return {
        "id": _text(next(_children(el, "id"), None)),
        "title": _text(next(_children(el, "title"), None)),
        "link": _web_link(href or ""),
        "published": _instant(_text(date)),
        "summary": _text(next(_children(el, "summary"), None)),
    }


def parse_feed(body: bytes, *, keep_summary: bool) -> list[dict[str, Any]]:
    """A feed's items: id, headline, link and publish time, and the summary when it may be kept.

    An item needs a headline and a link or an id; the id falls back to the link. Items repeat
    once at most and stop at ``MAX_ITEMS``. Raises ValueError for anything that is not a feed
    (an HTML challenge page, a document declaring entities, one too large to be a feed).
    """
    if len(body) > MAX_BYTES:
        msg = f"{len(body)} bytes, more than a feed's {MAX_BYTES}"
        raise ValueError(msg)
    if _ENTITY.search(body):
        msg = "the document declares entities, which no feed needs"
        raise ValueError(msg)
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        msg = f"not XML ({e})"
        raise ValueError(msg) from e
    kind = _local(root.tag)
    if kind == "feed":
        raw = [_atom_entry(e) for e in _children(root, "entry")]
    elif kind in ("rss", "RDF"):
        raw = [_rss_item(e) for e in root.iter() if _local(e.tag) == "item"]
    else:
        msg = f"not an RSS or Atom feed (root <{kind}>)"
        raise ValueError(msg)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in raw:
        title = _cut(r["title"], TITLE_CHARS)
        item_id = r["id"] or r["link"] or ""
        if not title or not item_id or item_id in seen:
            continue
        seen.add(item_id)
        item: dict[str, Any] = {
            "id": item_id,
            "title": title,
            "link": r["link"],
            "published": r["published"],
        }
        if keep_summary:
            item["summary"] = _cut(r["summary"], SUMMARY_CHARS) or None
        items.append(item)
        if len(items) >= MAX_ITEMS:
            break
    return items


def feed_key(feed: Feed, stamp: str) -> str:
    """The landing key: the feed and the Eastern hour (feed ids never hold a dot)."""
    return f"{feed.id}.{stamp}"


@dataclass
class RssIngestor:
    """Lands the league's feeds into an existing run summary."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    feeds: Sequence[Feed] | None = None
    now: datetime | None = None

    def land_into(self, summary: RunSummary) -> None:
        now = self.now or datetime.now(UTC)
        stamp = f"{now.astimezone(EASTERN):%Y-%m-%dT%H}"
        feeds = load_feeds() if self.feeds is None else self.feeds
        for feed in feeds:
            if feed.league == self.league:
                self._land(feed, stamp, now, summary)

    def _previous(self, scope: Scope, feed: Feed) -> tuple[str, Any, dict[str, Any]] | None:
        """The feed's last landing: its key, index entry and payload."""
        if self.landing.full_refresh:
            return None
        entries = self.landing.entries(scope)
        keys = [k for k in entries if k.split(".", 1)[0] == feed.id]
        if not keys:
            return None
        key = max(keys)
        body = self.landing.backend.read_bytes(PurePosixPath(entries[key].path))
        if not body:
            return None
        try:
            return key, entries[key], json.loads(body)
        except ValueError:
            return None

    def _land(self, feed: Feed, stamp: str, now: datetime, summary: RunSummary) -> None:
        scope = Scope(SOURCE, ENDPOINT, self.league, self.season)
        key = feed_key(feed, stamp)
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)  # this hour's run already asked
                return
            previous = self._previous(scope, feed)
            headers = {"User-Agent": CRAWLER_USER_AGENT, "Accept": ACCEPT}
            if previous is not None:
                if etag := previous[2].get("etag"):
                    headers["If-None-Match"] = etag
                if modified := previous[2].get("last_modified"):
                    headers["If-Modified-Since"] = modified
            response = self.client.get(feed.url, headers=headers)
            if response.status_code == 304 and previous is not None:
                summary.record(self._unchanged(previous, key))
                return
            if response.status_code != 200:
                where = response.headers.get("location")
                moved = f", moved to {where}: update rss_feeds.toml" if where else ""
                summary.miss(ENDPOINT, key, f"HTTP {response.status_code}{moved}")
                return
            items = parse_feed(response.content, keep_summary=feed.keeps_summary)
            if previous is not None and previous[2].get("items") == items:
                summary.record(self._unchanged(previous, key))
                return
            body = {
                "feed": asdict(feed),
                "fetched_at": now.isoformat(),
                "etag": response.headers.get("etag"),
                "last_modified": response.headers.get("last-modified"),
                "items": items,
            }
            result = self.landing.land(
                scope,
                key,
                json.dumps(body, ensure_ascii=False, indent=1).encode("utf-8"),
                url=feed.url,
                params={},
                status=200,
                fetched_at=now,
            )
            summary.record(result)
        except Exception as exc:  # an outlet's outage or a broken feed never fails the run
            summary.miss(ENDPOINT, key, f"{type(exc).__name__}: {exc}"[:300])

    @staticmethod
    def _unchanged(previous: tuple[str, Any, dict[str, Any]], key: str) -> LandResult:
        _, entry, _ = previous
        return LandResult("unchanged", PurePosixPath(entry.path), entry.sha256, ENDPOINT, key)


def land_feeds(landing: Landing, league: League, season: str, summary: RunSummary) -> None:
    """The league's feeds, through their own client: no retries, the crawler's User-Agent."""
    with ThrottledClient(THROTTLE) as client:
        RssIngestor(client, landing, league, season).land_into(summary)
        for host, stats in client.pacing().items():
            summary.pacing[host] = stats
