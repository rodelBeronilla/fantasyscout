"""The check a one-line player note passes before it is published (#823).

The model writes one line about one flagged player from the numbers and the texts it is given
(player_notes.py). The line is published only when everything in it can be found in its inputs:

- it fits the schema and is about the player it was asked about;
- every number it writes is one of the input's numbers, at the precision it is written (a share
  may be written as a percentage), as the weekly notes' validator holds them (validate.trace), or
  a number one of the input's texts writes (an injury note's "2-3 weeks", a headline's date);
- every quotation in it, in straight or curly double quotes, is a span of one of the texts a line
  may quote, as the claims' quote check holds a quote (claim_check.locate). Those are headlines,
  feed titles and summaries, and YouTube titles and descriptions only: a YouTube transcript's
  speech and an injury note's prose may lend a number, never their words;
- it rests on something: at least one number or quotation traced.

Each number and quotation becomes a claim naming what it is and the row it comes from, so the page
can say where a note's facts are from. A line that fails is dropped, with its reasons, for the
rejection log.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, ValidationError, field_validator

from ai.claim_check import locate
from ai.validate import NUMBER, decimals_of, trace

MAX_WORDS = 30
# a quotation in the line: straight or curly double quotes around at least one character
MINUS = chr(0x2212)
_OPEN, _CLOSE = chr(0x201C), chr(0x201D)
QUOTED = re.compile(f'["{_OPEN}]([^"{_OPEN}{_CLOSE}]+)["{_CLOSE}]')


class LineDraft(BaseModel):
    """What the model returns: one line about one player."""

    player_id: str
    line: str = Field(min_length=3, max_length=240)

    @field_validator("line")
    @classmethod
    def _one_short_line(cls, line: str) -> str:
        if "\n" in line.strip():
            msg = "the note runs over more than one line"
            raise ValueError(msg)
        if len(line.split()) > MAX_WORDS:
            msg = f"the note runs past {MAX_WORDS} words"
            raise ValueError(msg)
        return line.strip()


class Source(BaseModel):
    """One fact a published line states: the number or quotation, what it is, and its row."""

    what: str
    value: str
    row_ref: str


class PlayerNote(LineDraft):
    """A published line, with a source for every number and quotation in it."""

    sources: list[Source] = Field(min_length=1)


def line_schema() -> dict[str, Any]:
    """The JSON schema the model is held to (Ollama's ``format``)."""
    return LineDraft.model_json_schema()


def _value(token: str) -> float | None:
    try:
        return float(token.replace(MINUS, "-").replace(",", ".").rstrip("%"))
    except ValueError:
        return None


def text_numbers(text: str) -> list[float]:
    """Every number a text writes, without its sign (a date's "-12" is a 12)."""
    out = [_value(t) for t in NUMBER.findall(text)]
    return [abs(v) for v in out if v is not None]


def _in_texts(value: float, token: str, texts: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The first text that writes the number, at the precision the line writes it."""
    tol = 0.5 * 10 ** -decimals_of(token) + 1e-9
    for t in texts:
        if any(abs(abs(value) - n) <= tol for n in text_numbers(t["text"])):
            return t
    return None


def check(raw: Any, inp: dict[str, Any]) -> tuple[PlayerNote | None, list[str]]:
    """The line, with its sources, if it passes; and why it does not."""
    try:
        draft = LineDraft.model_validate(raw)
    except ValidationError as e:
        return None, [f"schema: {err['loc']}: {err['msg']}" for err in e.errors()][:5]
    reasons: list[str] = []
    if draft.player_id != inp["player_id"]:
        reasons.append(f"about {draft.player_id}, asked about {inp['player_id']}")
    texts: list[dict[str, Any]] = inp.get("texts", [])
    sources: list[Source] = []
    # the quotations first: a number inside one is the quoted text's
    quoted = list(QUOTED.finditer(draft.line))
    for m in quoted:
        quotable = [t for t in texts if t.get("quotable")]
        found = next((t for t in quotable if locate(m.group(1), t["text"])), None)
        if found is None:
            # the reason names no words: a rejection is logged, and the words may be a source's
            reasons.append(
                "a quotation is not a span of a headline, title or description given"
                f" ({len(m.group(1).split())} words)"
            )
            continue
        sources.append(Source(what=found["what"], value=m.group(1), row_ref=found["row_ref"]))
    inside = [range(m.start(), m.end()) for m in quoted]
    for m in NUMBER.finditer(draft.line):
        if any(m.start() in r for r in inside):
            continue
        token = m.group(0)
        value = _value(token)
        if value is None:
            continue
        claim = trace(value, inp, decimals_of(token))
        if claim is not None:
            metric = claim.metric.split(".", 1)[0]
            sources.append(Source(what=metric, value=token, row_ref=claim.row_ref))
            continue
        text = _in_texts(value, token, texts)
        if text is None:
            reasons.append(f"the note states {token}, which is in none of its inputs")
            continue
        sources.append(Source(what=text["what"], value=token, row_ref=text["row_ref"]))
    if not sources and not reasons:
        reasons.append("the note states no number or quotation from its inputs")
    if reasons:
        return None, reasons
    return PlayerNote(**draft.model_dump(), sources=sources), []
