"""Push the League Pulse extract into a Google Sheet, the one source Tableau Public refreshes on
its own (SPEC.md, "Dashboard"; tableau/README.md).

    GOOGLE_SERVICE_ACCOUNT_JSON='{...}' uv run python tableau/sheets.py --sheet-id <id> [--extract tableau/extract]

One tab per CSV file (``team_pace_ratings``, ``player_value``, ``data_health``), replaced in full
on every run; a missing tab is created. The sheet itself is created once by the owner and shared
with the service account, so the account never needs Drive access, only the Sheets API.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections.abc import Callable
from pathlib import Path

import httpx

SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
SCOPE = "https://www.googleapis.com/auth/spreadsheets"
TABS = ("team_pace_ratings", "player_value", "data_health")

TokenSource = Callable[[], str]


def service_account_token(info: dict[str, str]) -> str:
    """An access token for the service account (google-auth signs the JWT and exchanges it)."""
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    credentials = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
    credentials.refresh(Request())
    return str(credentials.token)


def _cell(value: str) -> str | float | int:
    """Numbers as numbers so Tableau types the columns; everything else as text."""
    if value == "":
        return ""
    try:
        if value.lower() in ("true", "false"):
            return value
        number = float(value)
    except ValueError:
        return value
    return int(number) if number.is_integer() and "." not in value else number


def read_rows(path: Path) -> list[list[str | float | int]]:
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        return [list(header), *[[_cell(v) for v in row] for row in reader]]


class SheetsClient:
    def __init__(self, token: TokenSource, *, transport: httpx.BaseTransport | None = None) -> None:
        self._token = token
        self._client = httpx.Client(timeout=120, transport=transport)
        self.calls: list[str] = []

    def _request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        self.calls.append(f"{method} {url.split('/v4/')[-1]}")
        response = self._client.request(
            method,
            url,
            headers={"Authorization": f"Bearer {self._token()}"},
            **kwargs,  # type: ignore[arg-type]
        )
        if response.status_code >= 400:
            msg = f"Sheets API {method} {url}: HTTP {response.status_code} {response.text[:300]}"
            raise RuntimeError(msg)
        return response

    def tabs(self, sheet_id: str) -> list[str]:
        body = self._request(
            "GET", f"{SHEETS_API}/{sheet_id}", params={"fields": "sheets.properties.title"}
        ).json()
        return [s["properties"]["title"] for s in body.get("sheets", [])]

    def add_tabs(self, sheet_id: str, titles: list[str]) -> None:
        if not titles:
            return
        requests = [{"addSheet": {"properties": {"title": t}}} for t in titles]
        self._request("POST", f"{SHEETS_API}/{sheet_id}:batchUpdate", json={"requests": requests})

    def replace(self, sheet_id: str, tab: str, rows: list[list[str | float | int]]) -> int:
        self._request("POST", f"{SHEETS_API}/{sheet_id}/values/{tab}!A1:Z:clear")
        self._request(
            "PUT",
            f"{SHEETS_API}/{sheet_id}/values/{tab}!A1",
            params={"valueInputOption": "RAW"},
            json={"range": f"{tab}!A1", "majorDimension": "ROWS", "values": rows},
        )
        return len(rows) - 1


def push(
    client: SheetsClient, sheet_id: str, extract: Path, log: Callable[[str], None] = print
) -> dict[str, int]:
    present = client.tabs(sheet_id)
    client.add_tabs(sheet_id, [t for t in TABS if t not in present])
    counts: dict[str, int] = {}
    for tab in TABS:
        path = extract / f"{tab}.csv"
        if not path.is_file():
            log(f"  {tab}: no file, left as is")
            continue
        counts[tab] = client.replace(sheet_id, tab, read_rows(path))
        log(f"  {tab}: {counts[tab]} rows")
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--sheet-id", default=os.environ.get("TABLEAU_SHEET_ID", ""))
    parser.add_argument("--extract", type=Path, default=Path("tableau/extract"))
    args = parser.parse_args(argv)
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not args.sheet_id or not raw:
        print(
            "Google Sheets bridge not configured (TABLEAU_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON); skipped"
        )
        return 0
    info = json.loads(raw)
    token = service_account_token(info)
    client = SheetsClient(lambda: token)
    try:
        counts = push(client, args.sheet_id, args.extract)
    except Exception as exc:  # the step reports and fails
        print(f"sheets push failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(f"pushed {sum(counts.values())} rows to sheet {args.sheet_id} ({', '.join(counts)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
