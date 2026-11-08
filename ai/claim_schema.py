"""The shape of a claim from the news (#812, #833): what the model extracts from one source item,
and what is landed once the claim is checked.

The model reads one item (an ESPN headline, or an ESPN injury note) and says, for each player
the item names, what the text claims about the player's role, minutes or injury. A claim keeps
the exact span of the text it rests on, so anyone can audit it against its source, and the date
the source said it, so a backtest can score it against what happened next.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal, get_args

from pydantic import BaseModel, Field

Kind = Literal[
    "role_up",
    "role_down",
    "minutes_up",
    "minutes_down",
    "injury_out",
    "injury_return",
    "injury_worse",
    "injury_better",
    "trade_rumor",
    "other",
]
Source = Literal["espn_news", "espn_injury_note"]
KINDS: tuple[str, ...] = get_args(Kind)
SOURCES: tuple[str, ...] = get_args(Source)

# The direction each kind states: +1 good for the player's fantasy value, -1 bad, 0 neither. A
# rumored trade says nothing yet about the player's value; "other" may go either way.
SIGN: dict[str, int | None] = {
    "role_up": 1,
    "role_down": -1,
    "minutes_up": 1,
    "minutes_down": -1,
    "injury_out": -1,
    "injury_return": 1,
    "injury_worse": -1,
    "injury_better": 1,
    "trade_rumor": 0,
    "other": None,
}
MAX_QUOTE = 300


class ExtractedClaim(BaseModel):
    """One claim as the model returns it."""

    player_id: str
    kind: Kind
    direction: Literal[-1, 0, 1]
    confidence: float = Field(ge=0.0, le=1.0)
    quote: str = Field(min_length=1, max_length=MAX_QUOTE)


class Extraction(BaseModel):
    """The model's answer for one source item: its claims, often none."""

    claims: list[ExtractedClaim] = Field(max_length=20)


class SourceClaim(BaseModel):
    """A landed claim: checked against its source, its confidence capped by rule."""

    league: Literal["nba", "wnba"]
    season: str
    # the league player id, as the lakehouse's crosswalks linked the item's players
    player_id: str
    kind: Kind
    direction: Literal[-1, 0, 1]
    # the model's own confidence, the rule-based cap, and the confidence kept (the lower)
    model_confidence: float = Field(ge=0.0, le=1.0)
    confidence_cap: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    cap_reasons: list[str] = Field(default_factory=list)
    # the span of the source text, exactly as the source writes it, and where it starts
    quote: str = Field(min_length=1, max_length=MAX_QUOTE)
    quote_start: int = Field(ge=0)
    source: Source
    source_id: str
    # when the source said it: the point-in-time date a backtest cuts on
    published_at: datetime
    published_date: date


def extraction_schema() -> dict[str, Any]:
    """The JSON schema the model is held to (Ollama's ``format``), with the claim inlined: no
    ``$ref`` for the grammar to resolve."""
    return {
        "type": "object",
        "properties": {"claims": {"type": "array", "items": ExtractedClaim.model_json_schema()}},
        "required": ["claims"],
    }
