"""Arrow tables to bytes: Parquet (zstd) and compact JSON that every browser can parse."""

from __future__ import annotations

import hashlib
import io
import json
import math
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq


def to_parquet(table: pa.Table) -> bytes:
    sink = io.BytesIO()
    pq.write_table(table, sink, compression="zstd")
    return sink.getvalue()


def _plain(value: Any) -> Any:
    """JSON-safe scalars: dates as ISO strings, decimals as floats, NaN and infinity as null."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, Decimal):
        number = float(value)
        return None if math.isnan(number) else number
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(v) for v in value]
    return value


def rows_of(table: pa.Table, digits: int | None = None) -> list[dict[str, Any]]:
    """The table as JSON-safe dicts, in row order; floats rounded when ``digits`` is set."""

    def cell(value: Any) -> Any:
        plain = _plain(value)
        if digits is not None and isinstance(plain, float):
            return round(plain, digits)
        return plain

    return [{k: cell(v) for k, v in row.items()} for row in table.to_pylist()]


def to_json(value: Any) -> bytes:
    return json.dumps(
        _plain(value), separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()
