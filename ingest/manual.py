"""Land the tables the owner saved while browsing (#792).

    fs-ingest import FILE... --source spotrac --league nba --season 2025-26 [--backend volume]

The Save tables bookmarklet (tools/save-tables) turns the tables of a page open in the owner's
browser into a JSON file. This is how pages from sites that refuse automated clients come in:
only those the owner visited, with no request sent on their behalf (ADR 0008's addendum of
2026-11-07). Each file is checked for the bookmarklet's shape and landed under
``landing/manual/saved_tables/<league>/<season>/<today>/<source>-<hash>.json``, the source (the
site the pages came from) written into the payload and the key. The hash is the file's content, so
a file saved or imported twice lands once. The sidecar records the page's address.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ingest.landing import League, eastern_date, payload_hash
from ingest.store import Backend, Landing, Scope

SOURCE = "manual"
ENDPOINT = "saved_tables"
SLUG = re.compile(r"^[a-z][a-z0-9_]{1,40}$")


@dataclass
class ImportResult:
    landed: int = 0
    unchanged: int = 0
    rejected: list[str] = field(default_factory=list)


def check_saved(doc: Any) -> str | None:
    """Why a file is not a Save tables file, or None when it is."""
    if not isinstance(doc, dict):
        return "not a JSON object"
    if not isinstance(doc.get("url"), str) or not doc["url"].startswith(("http://", "https://")):
        return "no page address (url)"
    if not isinstance(doc.get("saved_at"), str):
        return "no saved_at"
    tables = doc.get("tables")
    if not isinstance(tables, list) or not tables:
        return "no tables"
    for t in tables:
        if not isinstance(t, dict) or not isinstance(t.get("rows"), list):
            return "a table without rows"
        if not isinstance(t.get("headers", []), list):
            return "a table whose headers are not a list"
    return None


def import_files(
    backend: Backend,
    files: list[Path],
    *,
    source: str,
    league: League,
    season: str,
    now: datetime | None = None,
) -> ImportResult:
    """Land each valid file once under landing/manual/saved_tables/<league>/<season>/."""
    if not SLUG.match(source):
        msg = f"--source must be lower-case letters, digits and _: {source!r}"
        raise ValueError(msg)
    clock = now or datetime.now(UTC)
    landing = Landing(backend, ingest_date=eastern_date(clock))
    scope = Scope(SOURCE, ENDPOINT, league, season)
    result = ImportResult()
    try:
        for path in files:
            body = path.read_bytes()
            try:
                doc = json.loads(body)
            except ValueError:
                result.rejected.append(f"{path.name}: not JSON")
                continue
            if reason := check_saved(doc):
                result.rejected.append(f"{path.name}: {reason}")
                continue
            key = f"{source}-{payload_hash(body)[:16]}"
            if landing.has_landed(scope, key):
                result.unchanged += 1
                continue
            payload = {"source": source, "file": path.name, **doc}
            landed = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            landing.land(
                scope, key, landed, url=doc["url"], params={}, status=200, fetched_at=clock
            )
            result.landed += 1
    finally:
        landing.flush()
        landing.close()
    return result
