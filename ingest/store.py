"""Where landed payloads live, and the bookkeeping that makes re-runs no-ops.

Two backends share one layout (see ``ingest.landing``): a local directory for development
and CI, and the Unity Catalog volume ``fantasyscout.raw.landing`` through the Databricks
Files API. A small per-scope index (``_index.json`` next to the payloads) records the
SHA-256 of the last landing for every request key, so:

* a key already landed on the same ``ingest_date`` is not fetched again, and
* a fetched payload whose hash matches the last landing is not written again.

``--full-refresh`` bypasses both.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from typing import Literal, Protocol

import httpx

from ingest.landing import League, Sidecar, landing_key, payload_hash

INDEX_NAME = "_index.json"


def workspace_origin(host: str) -> str:
    """Reduce whatever was pasted as DATABRICKS_HOST to ``https://<workspace-host>``.

    People copy the URL from the browser, which may carry a path or an ``?o=`` query;
    the REST API lives at the bare origin.
    """
    raw = host.strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"https://{raw}"
    return f"https://{httpx.URL(raw).host}"


class Backend(Protocol):
    """Minimal file store: read (None when missing) and write bytes, creating parents."""

    def read_bytes(self, path: PurePosixPath) -> bytes | None: ...

    def write_bytes(self, path: PurePosixPath, body: bytes) -> None: ...


class LocalBackend:
    """Files under a local root. ``root/landing/<source>/...``."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _resolve(self, path: PurePosixPath) -> Path:
        return self.root.joinpath(*path.parts)

    def read_bytes(self, path: PurePosixPath) -> bytes | None:
        target = self._resolve(path)
        return target.read_bytes() if target.exists() else None

    def write_bytes(self, path: PurePosixPath, body: bytes) -> None:
        target = self._resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)


class VolumeBackend:
    """A Unity Catalog volume through the Databricks Files API.

    ``root`` is the schema-level path, so ``/Volumes/fantasyscout/raw`` plus the layout's
    leading ``landing/`` segment addresses the ``landing`` volume. Directories are created
    on demand and remembered for the life of the backend.
    """

    def __init__(
        self,
        host: str,
        token: str,
        *,
        root: str = "/Volumes/fantasyscout/raw",
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
    ) -> None:
        self.host = workspace_origin(host)
        self.root = root.rstrip("/")
        self._client = httpx.Client(
            headers={"Authorization": f"Bearer {token}"}, transport=transport, timeout=timeout
        )
        self._known_dirs: set[str] = set()

    def close(self) -> None:
        self._client.close()

    def _uc_create(self, kind: str, payload: dict[str, str]) -> str:
        """POST one Unity Catalog object; an existing object counts as success."""
        response = self._client.post(f"{self.host}/api/2.1/unity-catalog/{kind}", json=payload)
        if response.status_code in (200, 201):
            return "created"
        if response.status_code == 409 or "ALREADY_EXISTS" in response.text:
            return "exists"
        hint = ""
        if kind == "catalogs" and "Default Storage" in response.text:
            hint = (
                " Free Edition cannot create a catalog through the API without a storage "
                "location: create it once in the workspace UI (Catalog > Create catalog > "
                f"name {payload.get('name')!r}, Default storage), then re-run."
            )
        msg = (
            f"could not create {kind} {payload.get('name')}: "
            f"HTTP {response.status_code} {response.text[:300]}{hint}"
        )
        raise RuntimeError(msg)

    def ensure_volume(self, volume: str = "landing") -> dict[str, str]:
        """Create the catalog, schema and managed volume behind ``root`` if they are missing.

        The Files API never creates these; it answers 404 ``Catalog ... does not exist``.
        """
        parts = PurePosixPath(self.root).parts  # ('/', 'Volumes', catalog, schema)
        if len(parts) != 4 or parts[1] != "Volumes":
            msg = f"root must look like /Volumes/<catalog>/<schema>, got {self.root}"
            raise ValueError(msg)
        catalog, schema = parts[2], parts[3]
        return {
            "catalog": self._uc_create("catalogs", {"name": catalog}),
            "schema": self._uc_create("schemas", {"name": schema, "catalog_name": catalog}),
            "volume": self._uc_create(
                "volumes",
                {
                    "name": volume,
                    "catalog_name": catalog,
                    "schema_name": schema,
                    "volume_type": "MANAGED",
                },
            ),
        }

    def _volume_path(self, path: PurePosixPath) -> str:
        return f"{self.root}/{path.as_posix()}"

    def _files_url(self, path: PurePosixPath) -> str:
        return f"{self.host}/api/2.0/fs/files{self._volume_path(path)}"

    def _ensure_directory(self, directory: str) -> None:
        if directory in self._known_dirs:
            return
        response = self._client.put(f"{self.host}/api/2.0/fs/directories{directory}")
        if response.status_code not in (200, 204):
            msg = f"could not create {directory}: HTTP {response.status_code} {response.text[:200]}"
            raise RuntimeError(msg)
        self._known_dirs.add(directory)

    def read_bytes(self, path: PurePosixPath) -> bytes | None:
        response = self._client.get(self._files_url(path))
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            msg = f"could not read {path}: HTTP {response.status_code} {response.text[:200]}"
            raise RuntimeError(msg)
        return response.content

    def write_bytes(self, path: PurePosixPath, body: bytes) -> None:
        self._ensure_directory(self._volume_path(path.parent))
        response = self._client.put(
            self._files_url(path),
            params={"overwrite": "true"},
            content=body,
            headers={"Content-Type": "application/octet-stream"},
        )
        if response.status_code not in (200, 204):
            msg = f"could not write {path}: HTTP {response.status_code} {response.text[:200]}"
            raise RuntimeError(msg)


@dataclass(frozen=True)
class IndexEntry:
    sha256: str
    path: str
    ingest_date: str
    size_bytes: int


@dataclass(frozen=True)
class Scope:
    """One endpoint for one league-season: the unit the index is kept at."""

    source: str
    endpoint: str
    league: League
    season: str

    def index_path(self) -> PurePosixPath:
        return (
            landing_key(
                self.source, self.endpoint, self.league, self.season, date(1970, 1, 1), "x"
            ).parent.parent
            / INDEX_NAME
        )


Outcome = Literal["landed", "unchanged", "skipped"]


@dataclass(frozen=True)
class LandResult:
    outcome: Outcome
    path: PurePosixPath
    sha256: str


class Landing:
    """Writes payloads and sidecars through a backend and keeps the per-scope indexes."""

    def __init__(self, backend: Backend, *, ingest_date: date, full_refresh: bool = False) -> None:
        self.backend = backend
        self.ingest_date = ingest_date
        self.full_refresh = full_refresh
        self._indexes: dict[Scope, dict[str, IndexEntry]] = {}
        self._dirty: set[Scope] = set()

    def _index(self, scope: Scope) -> dict[str, IndexEntry]:
        if scope not in self._indexes:
            text = self.backend.read_bytes(scope.index_path())
            raw = json.loads(text) if text else {}
            self._indexes[scope] = {k: IndexEntry(**v) for k, v in raw.items()}
        return self._indexes[scope]

    def already_landed_today(self, scope: Scope, key: str) -> bool:
        """True when this key was landed on this ingest date and no full refresh was asked."""
        if self.full_refresh:
            return False
        entry = self._index(scope).get(key)
        return entry is not None and entry.ingest_date == self.ingest_date.isoformat()

    def read_latest(self, scope: Scope, key: str) -> bytes | None:
        """The most recently landed payload for a key, so planners can work without refetching."""
        entry = self._index(scope).get(key)
        if entry is None:
            return None
        return self.backend.read_bytes(PurePosixPath(entry.path))

    def land(
        self,
        scope: Scope,
        key: str,
        body: bytes,
        *,
        url: str,
        params: dict[str, str],
        status: int,
        fetched_at: datetime,
    ) -> LandResult:
        sha = payload_hash(body)
        path = landing_key(
            scope.source, scope.endpoint, scope.league, scope.season, self.ingest_date, key
        )
        index = self._index(scope)
        previous = index.get(key)
        if previous is not None and previous.sha256 == sha and not self.full_refresh:
            return LandResult("unchanged", PurePosixPath(previous.path), sha)

        sidecar = Sidecar.for_response(
            url=url, params=params, status=status, body=body, fetched_at=fetched_at
        )
        self.backend.write_bytes(path, body)
        self.backend.write_bytes(
            sidecar.sidecar_path(path), sidecar.model_dump_json(indent=2).encode("utf-8")
        )
        index[key] = IndexEntry(
            sha256=sha,
            path=path.as_posix(),
            ingest_date=self.ingest_date.isoformat(),
            size_bytes=len(body),
        )
        self._dirty.add(scope)
        return LandResult("landed", path, sha)

    def flush(self) -> None:
        """Persist every index touched in this run."""
        for scope in sorted(self._dirty, key=lambda s: (s.source, s.endpoint, s.league, s.season)):
            payload = {k: asdict(v) for k, v in sorted(self._indexes[scope].items())}
            self.backend.write_bytes(
                scope.index_path(), (json.dumps(payload, indent=2) + "\n").encode("utf-8")
            )
        self._dirty.clear()
