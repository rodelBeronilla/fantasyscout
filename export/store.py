"""Where a build is published: a local directory (development, tests) or the R2 bucket.

R2 is driven through the Cloudflare API's per-object endpoint, the same one `wrangler r2
object` uses, so the export needs only the account id and the API token the deploy already
has: no S3 keys. Writes are retried on rate limiting and server errors and run on a small
thread pool, because a build is a few thousand small files.
"""

from __future__ import annotations

import contextlib
import threading
import time
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol

import httpx

CONTENT_TYPES = {
    "json": "application/json",
    "parquet": "application/vnd.apache.parquet",
    "txt": "text/plain; charset=utf-8",
}
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_RETRIES = 5


def content_type_for(key: str) -> str:
    return CONTENT_TYPES.get(key.rsplit(".", 1)[-1].lower(), "application/octet-stream")


class Store(Protocol):
    def get(self, key: str) -> bytes | None: ...

    def put(self, key: str, body: bytes) -> None: ...

    def delete(self, key: str) -> None: ...


class LocalStore:
    """A directory laid out exactly like the bucket; `web/public/data` for local development."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, key: str) -> Path:
        return self.root / Path(*key.split("/"))

    def get(self, key: str) -> bytes | None:
        path = self._path(key)
        return path.read_bytes() if path.is_file() else None

    def put(self, key: str, body: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)

    def delete(self, key: str) -> None:
        with contextlib.suppress(FileNotFoundError):
            self._path(key).unlink()


class R2Store:
    def __init__(
        self,
        account_id: str,
        token: str,
        bucket: str = "fantasyscout-data",
        *,
        transport: httpx.BaseTransport | None = None,
        sleep: float = 1.0,
    ) -> None:
        if not (account_id and token):
            msg = "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for the R2 store"
            raise RuntimeError(msg)
        self._base = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/buckets/{bucket}/objects/"
        self._client = httpx.Client(
            headers={"Authorization": f"Bearer {token}"}, timeout=120, transport=transport
        )
        self._sleep = sleep
        self.requests = 0
        self._lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def _send(self, method: str, key: str, **kwargs: object) -> httpx.Response:
        url = self._base + key
        for attempt in range(_RETRIES + 1):
            with self._lock:
                self.requests += 1
            response = self._client.request(method, url, **kwargs)  # type: ignore[arg-type]
            if response.status_code not in _RETRY_STATUSES or attempt == _RETRIES:
                return response
            delay = min(30.0, self._sleep * 2**attempt)
            with contextlib.suppress(ValueError):
                delay = max(delay, float(response.headers.get("retry-after", "0")))
            time.sleep(delay)
        return response  # pragma: no cover

    def get(self, key: str) -> bytes | None:
        response = self._send("GET", key)
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            msg = f"could not read {key}: HTTP {response.status_code} {response.text[:200]}"
            raise RuntimeError(msg)
        return response.content

    def put(self, key: str, body: bytes) -> None:
        response = self._send(
            "PUT", key, content=body, headers={"Content-Type": content_type_for(key)}
        )
        if response.status_code not in (200, 201, 204):
            msg = f"could not write {key}: HTTP {response.status_code} {response.text[:200]}"
            raise RuntimeError(msg)

    def delete(self, key: str) -> None:
        response = self._send("DELETE", key)
        if response.status_code not in (200, 204, 404):
            msg = f"could not delete {key}: HTTP {response.status_code} {response.text[:200]}"
            raise RuntimeError(msg)


def put_many(store: Store, items: Iterable[tuple[str, bytes]], *, workers: int = 8) -> int:
    """Write every (key, body) pair, several at a time; the first failure is raised."""
    count = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for _ in pool.map(lambda kv: store.put(kv[0], kv[1]), items):
            count += 1
    return count


def delete_many(store: Store, keys: Iterable[str], *, workers: int = 8) -> int:
    count = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for _ in pool.map(store.delete, keys):
            count += 1
    return count
