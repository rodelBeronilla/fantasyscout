"""Where a build is published: a local directory (development, tests) or the R2 bucket.

R2 is driven through the Cloudflare API's per-object endpoint, the same one `wrangler r2
object` uses, so the export needs only the account id and the API token the deploy already
has: no S3 keys. Writes are retried on rate limiting and server errors and run on a small
thread pool, because a build is a few thousand small files.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Protocol

import httpx

from ingest.http import retrying_send

CONTENT_TYPES = {
    "json": "application/json",
    "parquet": "application/vnd.apache.parquet",
    "txt": "text/plain; charset=utf-8",
    "html": "text/html; charset=utf-8",
}
_RETRIES = 5


def content_type_for(key: str) -> str:
    return CONTENT_TYPES.get(key.rsplit(".", 1)[-1].lower(), "application/octet-stream")


class Store(Protocol):
    def get(self, key: str) -> bytes | None: ...

    def put(self, key: str, body: bytes) -> None: ...

    def delete(self, key: str) -> None: ...

    def list(self, prefix: str) -> list[str]: ...


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

    def list(self, prefix: str) -> list[str]:
        """Every key that starts with ``prefix``, sorted."""
        root = self._path("")
        return sorted(
            k
            for p in root.rglob("*")
            if p.is_file() and (k := p.relative_to(root).as_posix()).startswith(prefix)
        )


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
        # Whether the API takes a list of keys in one DELETE; the first refusal turns it off (#446).
        self.bulk_delete = True

    def close(self) -> None:
        self._client.close()

    def _send(
        self, method: str, key: str, *, url: str | None = None, **kwargs: Any
    ) -> httpx.Response:
        return retrying_send(
            self._client,
            method,
            url or self._base + key,
            retries=_RETRIES,
            base_delay=self._sleep,
            on_attempt=self._count,
            **kwargs,
        )

    def _count(self) -> None:
        with self._lock:
            self.requests += 1

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

    def delete_keys(self, keys: list[str]) -> bool:
        """Delete up to 1,000 keys in one request; False when the API refuses the list.

        Pruning a build is about 1,500 files, and one request per file under the API's 1,200
        requests per five minutes took six minutes (#446). The objects endpoint takes a JSON list
        of keys on DELETE. The first answer that is not success turns the list off for the run,
        and the caller deletes those keys one request each, as before.
        """
        if not (self.bulk_delete and keys):
            return False
        response = self._send("DELETE", "", url=self._base.rstrip("/"), json=keys)
        with contextlib.suppress(ValueError):
            if response.status_code == 200 and response.json().get("success") is True:
                return True
        self.bulk_delete = False
        return False

    def list(self, prefix: str) -> list[str]:
        """Every key that starts with ``prefix``, sorted, through the API's paged object listing."""
        keys: list[str] = []
        cursor = ""
        while True:
            params = {"prefix": prefix, "per_page": "1000"} | ({"cursor": cursor} if cursor else {})
            response = self._client.get(self._base.rstrip("/"), params=params)
            with self._lock:
                self.requests += 1
            if response.status_code != 200:
                msg = f"could not list {prefix}: HTTP {response.status_code} {response.text[:200]}"
                raise RuntimeError(msg)
            body = response.json()
            keys += [str(o["key"]) for o in body.get("result") or [] if isinstance(o, dict)]
            info = body.get("result_info") or {}
            cursor = str(info.get("cursor") or "")
            if not info.get("is_truncated") or not cursor:
                return sorted(keys)


def put_many(store: Store, items: Iterable[tuple[str, bytes]], *, workers: int = 8) -> int:
    """Write every (key, body) pair, several at a time; the first failure is raised."""
    count = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for _ in pool.map(lambda kv: store.put(kv[0], kv[1]), items):
            count += 1
    return count


BULK_DELETE = 1000


def delete_many(store: Store, keys: Iterable[str], *, workers: int = 8) -> int:
    """Delete every key: in lists of 1,000 where the store takes them, else several at a time."""
    listed = list(keys)
    bulk = getattr(store, "delete_keys", None)
    done = 0
    while bulk is not None and done < len(listed) and bulk(listed[done : done + BULK_DELETE]):
        done += BULK_DELETE
    rest = listed[done:]
    count = len(listed) - len(rest)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for _ in pool.map(store.delete, rest):
            count += 1
    return count
