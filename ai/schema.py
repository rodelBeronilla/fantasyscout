"""The shape of a note: what the model drafts, and what is published once every number in it is
traced to the build (SPEC.md, "Weekly scouting notes").

The model writes words only: a headline, a body and its confidence. The claims are not the
model's: the validator finds, for every number the text states, the input's number it is
(validate.py), so a published note's claims are the build's by construction.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

MAX_WORDS = 60


class Draft(BaseModel):
    """What the model returns."""

    player_id: str
    headline: str = Field(min_length=3, max_length=120)
    body: str = Field(min_length=3)
    confidence: Literal["low", "medium", "high"]

    @field_validator("body")
    @classmethod
    def _short(cls, body: str) -> str:
        if len(body.split()) > MAX_WORDS:
            msg = f"the body runs past {MAX_WORDS} words"
            raise ValueError(msg)
        return body


class Claim(BaseModel):
    """One number a note states: which metric and part, its value, and the row it comes from."""

    metric: str
    value: float
    row_ref: str


class Note(Draft):
    """A published note: the draft, with a claim for every number it states."""

    claims: list[Claim] = Field(min_length=1)


def draft_schema() -> dict[str, Any]:
    """The JSON schema the model is held to (Ollama's ``format``)."""
    return Draft.model_json_schema()
