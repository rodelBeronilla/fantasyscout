"""Landing-zone layout for raw payloads.

Every ingestor writes the raw response untouched to
``landing/{source}/{endpoint}/{league}/{season}/{ingest_date}/{key}.json``
plus a sidecar with the request metadata, so a later run can prove what was
fetched and skip anything already landed with the same hash (see SPEC.md,
"Rules for every ingestor").
"""

from __future__ import annotations

import hashlib
import re
from datetime import date, datetime
from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, Field

League = Literal["wnba", "nba"]

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug(part: str) -> str:
    """Make a path component safe: no separators, no spaces, nothing surprising."""
    cleaned = _SAFE.sub("-", part.strip()).strip("-")
    if not cleaned or cleaned in {".", ".."}:
        msg = f"unusable path component: {part!r}"
        raise ValueError(msg)
    return cleaned


def landing_key(
    source: str,
    endpoint: str,
    league: League,
    season: str,
    ingest_date: date,
    key: str,
) -> PurePosixPath:
    """Return the relative landing path for one raw payload (without the volume root)."""
    return PurePosixPath(
        "landing",
        _slug(source),
        _slug(endpoint),
        league,
        _slug(season),
        ingest_date.isoformat(),
        f"{_slug(key)}.json",
    )


def payload_hash(body: bytes) -> str:
    """SHA-256 of the raw bytes, the identity used for idempotent re-runs."""
    return hashlib.sha256(body).hexdigest()


class Sidecar(BaseModel):
    """Metadata written next to every landed payload (``{key}.meta.json``)."""

    url: str
    params: dict[str, str] = Field(default_factory=dict)
    status: int
    size_bytes: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    fetched_at: datetime

    @classmethod
    def for_response(
        cls,
        url: str,
        params: dict[str, str],
        status: int,
        body: bytes,
        fetched_at: datetime,
    ) -> Sidecar:
        return cls(
            url=url,
            params=params,
            status=status,
            size_bytes=len(body),
            sha256=payload_hash(body),
            fetched_at=fetched_at,
        )

    def sidecar_path(self, landing_path: PurePosixPath) -> PurePosixPath:
        return landing_path.with_suffix(".meta.json")
