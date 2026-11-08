"""The checks a claim passes before it is landed (#833), and the cap on its confidence.

The model reads one source item and returns claims (claim_schema.Extraction). Each is kept only
when:

- it is about one of the players the item names (the players the lakehouse linked it to);
- its quote is a span of the item's text: the same characters, read without regard to case or
  to curly versus straight quotes and dashes. The span kept is the source's own, with where it
  starts, so the claim can be audited against the text;
- its direction is the one its kind states (an ``injury_out`` is never good news).

Same player and kind twice in one item: the more confident is kept. The model's confidence is
then capped by rule, so a hedge or a headline never reads as a plain fact (``cap``).
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import ValidationError

from ai.claim_schema import (
    RSS_PREFIX,
    SIGN,
    YOUTUBE_PREFIX,
    ExtractedClaim,
    Extraction,
    SourceClaim,
)

MIN_QUOTE = 4
# the cap a source carries before anything else: a headline compresses its story, and the story,
# with its qualifiers, is not landed (ingest/espn_news.py); an injury note is the desk's own words
SOURCE_CAP = {"espn_news": 0.8, "espn_injury_note": 0.9}
# an outlet's feed item is a headline too, at most with the feed's short teaser, and its story is
# never fetched (ingest/rss.py): the headline's cap
RSS_CAP = 0.8
# a YouTube video's title and description is how the channel packages an analyst's take, not
# reporting; its transcript is the take itself, spoken, often read from automatic captions that
# can mishear a word: lower still (ingest/youtube.py)
YOUTUBE_CAP = 0.7
SPOKEN_CAP = 0.6
# a headline that names several players often says the claim about one of them only
SHARED_CAP = 0.7
# a rumor is a rumor, and "other" has no track record to lean on yet
KIND_CAP = {"trade_rumor": 0.5, "other": 0.5}
SHORT_QUOTE_WORDS = 3
SHORT_QUOTE_CAP = 0.6
# words that hedge a claim, looked for in the sentence the quote is in ("may" in lower case only:
# "returns in May" is a date)
SPECULATION = re.compile(
    r"\b(could|(?-i:may)|might|possibl[ey]|reportedly|rumou?r(ed|s)?|consider(s|ing)?|hop(e|es|ing)"
    r"|potential(ly)?|eyeing|interest(ed)?|explor(e|es|ing)|talks?)\b",
    re.I,
)
EXPECTATION = re.compile(
    r"\b(expect(s|ed)?|likely|probable|projected|anticipated|questionable|doubtful|uncertain"
    r"|unclear|tentative(ly)?|day-to-day|hopeful|optimistic|targeting|aims?)\b",
    re.I,
)
SPECULATION_CAP = 0.4
EXPECTATION_CAP = 0.7

# curly quotes, en and em dashes and a no-break space, read as their plain forms
_CURLY = {0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"', 0x2013: "-", 0x2014: "-", 0xA0: " "}
_FOLD = str.maketrans({chr(k): v for k, v in _CURLY.items()})
# what a quote may be wrapped in: white space and quote marks, straight or curly
_TRIM = "".join(chr(k) for k in (0x20, 0x09, 0x0A, 0x22, 0x27, 0x2018, 0x2019, 0x201C, 0x201D))


def _fold(text: str) -> str:
    folded = text.translate(_FOLD)
    lowered = folded.lower()
    # lower() keeps the length for every character the news uses; where it would not, keep case
    return lowered if len(lowered) == len(folded) else folded


def locate(quote: str, text: str) -> tuple[int, str] | None:
    """Where the quote is in the text, and the text's own span; None when it is not there."""
    needle = quote.strip(_TRIM)
    if len(needle) < MIN_QUOTE:
        return None
    at = _fold(text).find(_fold(needle))
    if at < 0:
        return None
    return at, text[at : at + len(needle)]


def _sentence(text: str, start: int, end: int) -> str:
    """The sentence (or line) a span sits in."""
    left = max(text.rfind(c, 0, start) for c in ".!?\n") + 1
    rights = [i for i in (text.find(c, end) for c in ".!?\n") if i >= 0]
    return text[left : min(rights) + 1 if rights else len(text)]


def source_cap(source: str, part: str | None = None) -> float:
    """The cap a source carries before any other rule (a YouTube item's by its part)."""
    if source.startswith(YOUTUBE_PREFIX):
        return SPOKEN_CAP if part == "transcript" else YOUTUBE_CAP
    return RSS_CAP if source.startswith(RSS_PREFIX) else SOURCE_CAP[source]


def _source_reason(item: dict[str, Any]) -> str:
    spoken = ", spoken (a transcript)" if item.get("part") == "transcript" else ""
    return f"source {item['source']}{spoken}"


def cap(item: dict[str, Any], kind: str, quote: str, start: int) -> tuple[float, list[str]]:
    """The most confidence a claim may keep, and why it is not 1."""
    caps: list[tuple[float, str]] = [
        (source_cap(item["source"], item.get("part")), _source_reason(item)),
    ]
    if len(item["players"]) > 1:
        caps.append((SHARED_CAP, f"the item names {len(item['players'])} players"))
    if kind in KIND_CAP:
        caps.append((KIND_CAP[kind], f"kind {kind}"))
    if len(quote.split()) < SHORT_QUOTE_WORDS:
        caps.append((SHORT_QUOTE_CAP, f"a quote of fewer than {SHORT_QUOTE_WORDS} words"))
    sentence = _sentence(item["text"], start, start + len(quote))
    if m := SPECULATION.search(sentence):
        caps.append((SPECULATION_CAP, f"hedged: {m.group(0).lower()}"))
    elif m := EXPECTATION.search(sentence):
        caps.append((EXPECTATION_CAP, f"an expectation: {m.group(0).lower()}"))
    lowest = min(c for c, _ in caps)
    return lowest, [why for c, why in caps if c == lowest]


def _reject(claim: ExtractedClaim, reason: str) -> dict[str, Any]:
    return {"reason": reason, "claim": claim.model_dump()}


def _check(item: dict[str, Any], claim: ExtractedClaim) -> SourceClaim | str:
    if claim.player_id not in {p["player_id"] for p in item["players"]}:
        return f"about {claim.player_id}, a player the item does not name"
    found = locate(claim.quote, item["text"])
    if found is None:
        return "the quote is not a span of the source text"
    start, span = found
    sign = SIGN[claim.kind]
    if sign is not None and claim.direction != sign:
        return f"direction {claim.direction:+d} for {claim.kind}, which is {sign:+d}"
    ceiling, why = cap(item, claim.kind, span, start)
    return SourceClaim(
        league=item["league"],
        season=item["season"],
        player_id=claim.player_id,
        kind=claim.kind,
        direction=claim.direction,
        model_confidence=claim.confidence,
        confidence_cap=ceiling,
        confidence=round(min(claim.confidence, ceiling), 3),
        cap_reasons=why,
        quote=span,
        quote_start=start,
        source=item["source"],
        source_id=item["source_id"],
        published_at=item["published_at"],
        published_date=item["published_date"],
    )


def review(item: dict[str, Any], raw: Any) -> tuple[list[SourceClaim], list[dict[str, Any]]]:
    """The item's claims that pass, one per player and kind, and the ones that do not, with
    their reasons."""
    try:
        answer = Extraction.model_validate(raw)
    except ValidationError as e:
        reasons = [f"schema: {err['loc']}: {err['msg']}" for err in e.errors()][:5]
        return [], [{"reason": r, "claim": None} for r in reasons]
    kept: dict[tuple[str, str], SourceClaim] = {}
    rejected: list[dict[str, Any]] = []
    for claim in answer.claims:
        checked = _check(item, claim)
        if isinstance(checked, str):
            rejected.append(_reject(claim, checked))
            continue
        key = (checked.player_id, checked.kind)
        if key not in kept or checked.confidence > kept[key].confidence:
            kept[key] = checked
    return list(kept.values()), rejected
