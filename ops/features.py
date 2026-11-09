"""The feature list (#947): methodology/features.yml, checked and turned into TypeScript.

Written with the parameter registry by ``uv run python -m ops.parameters`` (``--check`` fails when
either is stale or wrong). Each feature the site shows or hides names its verdict, its switch in
web/src/lib/visibility.ts or whether it shows, its ADR and issue, the registry entries it is built
on and when it is next judged. The Methodology page leads with it as its verdict table, and
web/src/lib/features.test.ts holds the switches to it.
"""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
FEATURES = ROOT / "methodology" / "features.yml"
ADRS = ROOT / "docs" / "adr"
OUT = ROOT / "web" / "src" / "generated" / "features.ts"

VERDICTS = {"validated", "failed", "open", "data"}
SHOWN = {"shown", "badged", "hidden"}
REQUIRED = {"id", "what", "page", "verdict", "parameters", "next"}
FIELDS = REQUIRED | {"switch", "shown", "adr", "issue", "dates", "bar"}
REPO = "https://github.com/rodelBeronilla/fantasyscout"


def load(path: Path = FEATURES) -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data


def _adr_exists(number: int, adrs: Path) -> bool:
    return any(adrs.glob(f"{number:04d}-*.md"))


def _row_problems(
    f: dict[str, Any], pages: dict[str, Any], params: set[str], adrs: Path
) -> Iterable[str]:
    fid = str(f.get("id", "?"))
    if missing := REQUIRED - f.keys():
        yield f"{fid}: missing {sorted(missing)}"
    if extra := f.keys() - FIELDS:
        yield f"{fid}: unknown fields {sorted(extra)}"
    if f.get("verdict") not in VERDICTS:
        yield f"{fid}: verdict {f.get('verdict')!r} is not one of {sorted(VERDICTS)}"
    if ("switch" in f) == ("shown" in f):
        yield f"{fid}: give either a switch or whether it is shown, not both"
    if "shown" in f and f["shown"] not in SHOWN:
        yield f"{fid}: shown {f['shown']!r} is not one of {sorted(SHOWN)}"
    if f.get("page") not in pages:
        yield f"{fid}: page {f.get('page')!r} is not one of {sorted(pages)}"
    if "adr" in f and not (isinstance(f["adr"], int) and _adr_exists(f["adr"], adrs)):
        yield f"{fid}: ADR {f['adr']!r} is not in docs/adr"
    if f.get("verdict") != "data" and not isinstance(f.get("issue"), int):
        yield f"{fid}: a judged feature names the issue that tracks it"
    for pid in f.get("parameters") or []:
        if pid not in params:
            yield f"{fid}: parameter {pid} is not in the registry"
    dates = f.get("dates", [])
    if not all(isinstance(d, dt.date) for d in dates) or dates != sorted(dates):
        yield f"{fid}: dates must be YYYY-MM-DD, in order"
    if "bar" in f and not str(f["bar"]).startswith(f"{REPO}/issues/{f.get('issue')}#issuecomment-"):
        yield f"{fid}: the bar must be a comment on its issue (#{f.get('issue')})"


def problems(data: dict[str, Any], params: set[str], adrs: Path = ADRS) -> list[str]:
    """What is wrong with the list: fields, enums, pages, ADRs, parameters, dates, duplicates."""
    pages = data.get("pages") or {}
    found: list[str] = []
    seen: set[str] = set()
    for f in data.get("features") or []:
        found.extend(_row_problems(f, pages, params, adrs))
        fid = str(f.get("id", "?"))
        if fid in seen:
            found.append(f"{fid}: listed twice")
        seen.add(fid)
        if "switch" in f and [g.get("switch") for g in data["features"]].count(f["switch"]) > 1:
            found.append(f"{fid}: switch {f['switch']} is named by more than one feature")
    return found


def _plain(value: Any) -> Any:
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def adr_files(data: dict[str, Any], adrs: Path = ADRS) -> dict[str, str]:
    """Each ADR the list names, by number, and its file in docs/adr."""
    numbers = sorted({f["adr"] for f in data["features"] if "adr" in f})
    return {str(n): next(adrs.glob(f"{n:04d}-*.md")).name for n in numbers}


def render(data: dict[str, Any]) -> str:
    features = [{k: _plain(v) for k, v in f.items()} for f in data["features"]]
    return (
        "// Generated from methodology/features.yml by `uv run python -m ops.parameters`;"
        " do not edit (#947).\n\n"
        f"{TYPES}\n"
        "/** The pages a feature lives on. */\n"
        "export const PAGES: Readonly<Record<string, Page>> = "
        f"{json.dumps(data['pages'], indent=2)};\n\n"
        "/** The file of each ADR a feature names, by number, in docs/adr. */\n"
        "export const ADR_FILES: Readonly<Record<string, string>> = "
        f"{json.dumps(adr_files(data), indent=2)};\n\n"
        "/** Every feature the site shows or hides, and its verdict: the Methodology table. */\n"
        f"export const FEATURES: readonly Feature[] = {json.dumps(features, indent=2)};\n"
    )


TYPES = """/** A page: its name, and its address when it has one of its own. */
export interface Page {
  readonly label: string;
  readonly path?: string;
}

/** A feature and the verdict on it (methodology/features.yml explains each field). */
export interface Feature {
  readonly id: string;
  readonly what: string;
  readonly page: string;
  readonly verdict: 'validated' | 'failed' | 'open' | 'data';
  readonly switch?: string;
  readonly shown?: 'shown' | 'badged' | 'hidden';
  readonly adr?: number;
  readonly issue?: number;
  readonly parameters: readonly string[];
  readonly next: string;
  readonly dates?: readonly string[];
  readonly bar?: string;
}
"""
