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
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol

import httpx

from ingest.http import retrying_send
from ingest.landing import League, Sidecar, landing_key, payload_hash

INDEX_NAME = "_index.json"
# Landings between two writes of the indexes. A run killed mid-way (a job timeout, a runner
# restart) then loses at most this many entries, not the whole run's; the payloads already in
# the volume are re-fetched once, not re-landed under a new date.
FLUSH_EVERY = 25
# Days after a game by which the leagues' stat corrections are in: a game's payload landed this
# long after it was played is final, and fetching it again returns the same bytes.
SETTLE_DAYS = 2
_WRITE_RETRIES = 4


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


# A service principal's OAuth client credentials (the principal's Secrets tab in the workspace)
# are exchanged for a one-hour access token at the workspace's token endpoint. The principal holds
# only the landing grants, the secret never leaves the job's environment, and the token is renewed
# before it expires, so a backfill that runs for hours keeps going. Databricks' own tooling reads
# the same two variables.
TOKEN_PATH = "/oidc/v1/token"
TOKEN_RENEW_MARGIN = 300.0  # seconds before expiry at which the next request fetches a new token


class ClientCredentials(httpx.Auth):
    """``httpx.Auth`` that signs every request with a current access token for the principal."""

    requires_response_body = False

    def __init__(
        self,
        host: str,
        client_id: str,
        client_secret: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.host = workspace_origin(host)
        self.client_id = client_id
        self._secret = client_secret
        self._clock = clock
        self._http = httpx.Client(transport=transport, timeout=timeout)
        self._lock = threading.Lock()
        self._token = ""
        self._expires_at = 0.0
        self.exchanges = 0

    def token(self, *, force: bool = False) -> str:
        """The current access token, fetched when there is none or it is about to expire."""
        with self._lock:
            if force or not self._token or self._clock() >= self._expires_at:
                response = self._http.post(
                    f"{self.host}{TOKEN_PATH}",
                    auth=(self.client_id, self._secret),
                    data={"grant_type": "client_credentials", "scope": "all-apis"},
                )
                if response.status_code != 200:
                    msg = (
                        "the service principal's client credentials were refused: "
                        f"HTTP {response.status_code} {response.text[:200]}"
                    )
                    raise RuntimeError(msg)
                body = response.json()
                self._token = str(body["access_token"])
                lifetime = float(body.get("expires_in", 3600))
                self._expires_at = self._clock() + max(lifetime - TOKEN_RENEW_MARGIN, 30.0)
                self.exchanges += 1
            return self._token

    def auth_flow(self, request: httpx.Request):  # type: ignore[no-untyped-def]
        request.headers["Authorization"] = f"Bearer {self.token()}"
        response = yield request
        if response.status_code == 401:
            # the token was revoked or expired early: one fresh token, one retry
            request.headers["Authorization"] = f"Bearer {self.token(force=True)}"
            yield request

    def close(self) -> None:
        self._http.close()


def credentials_from_env(
    env: Mapping[str, str], *, transport: httpx.BaseTransport | None = None
) -> httpx.Auth | None:
    """The principal's client credentials when the environment carries both, else None."""
    client_id = env.get("DATABRICKS_CLIENT_ID", "")
    secret = env.get("DATABRICKS_CLIENT_SECRET", "")
    host = env.get("DATABRICKS_HOST", "")
    if client_id and secret and host:
        return ClientCredentials(host, client_id, secret, transport=transport)
    return None


class Backend(Protocol):
    """Minimal file store: read (None when missing), write bytes, and create directories."""

    def read_bytes(self, path: PurePosixPath) -> bytes | None: ...

    def list_files(self, directory: PurePosixPath) -> list[PurePosixPath]: ...

    def write_bytes(self, path: PurePosixPath, body: bytes) -> None: ...

    def ensure_directory(self, path: PurePosixPath) -> None: ...


class LocalBackend:
    """Files under a local root. ``root/landing/<source>/...``."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _resolve(self, path: PurePosixPath) -> Path:
        return self.root.joinpath(*path.parts)

    def read_bytes(self, path: PurePosixPath) -> bytes | None:
        target = self._resolve(path)
        return target.read_bytes() if target.exists() else None

    def list_files(self, directory: PurePosixPath) -> list[PurePosixPath]:
        """Every file under the directory, recursively, as paths relative to the root."""
        base = self._resolve(directory)
        if not base.is_dir():
            return []
        return sorted(
            PurePosixPath(p.relative_to(self.root).as_posix())
            for p in base.rglob("*")
            if p.is_file()
        )

    def list_directory(self, directory: PurePosixPath) -> list[tuple[PurePosixPath, bool]]:
        """The directory's own entries (not recursive), each with whether it is a directory."""
        base = self._resolve(directory)
        if not base.is_dir():
            return []
        return sorted(
            (PurePosixPath(p.relative_to(self.root).as_posix()), p.is_dir()) for p in base.iterdir()
        )

    def ensure_directory(self, path: PurePosixPath) -> None:
        self._resolve(path).mkdir(parents=True, exist_ok=True)

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
        auth: httpx.Auth | None = None,
    ) -> None:
        self.host = workspace_origin(host)
        self.root = root.rstrip("/")
        # a service principal's credentials sign each request; a token is a fixed header
        headers = {} if auth is not None else {"Authorization": f"Bearer {token}"}
        self._client = httpx.Client(
            headers=headers, auth=auth, transport=transport, timeout=timeout
        )
        self._known_dirs: set[str] = set()
        self._dir_lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def _uc_ensure(self, kind: str, full_name: str, payload: dict[str, str]) -> str:
        """Return "exists" when the Unity Catalog object is there, else create it.

        Existence is checked first: Databricks validates storage before it checks for
        duplicates, so a blind POST can fail for a catalog that already exists.
        """
        base = f"{self.host}/api/2.1/unity-catalog/{kind}"
        found = self._client.get(f"{base}/{full_name}")
        if found.status_code == 200:
            return "exists"
        if found.status_code != 404:
            msg = f"could not read {kind} {full_name}: HTTP {found.status_code} {found.text[:300]}"
            raise RuntimeError(msg)
        created = self._client.post(base, json=payload)
        if created.status_code in (200, 201):
            return "created"
        if created.status_code == 409 or "ALREADY_EXISTS" in created.text:
            return "exists"
        hint = ""
        if kind == "catalogs":
            visible = self._client.get(base)
            names = (
                [c.get("name", "?") for c in visible.json().get("catalogs", [])]
                if visible.status_code == 200
                else []
            )
            hint = f" Catalogs visible to this token: {names or 'none'}."
            if "Default Storage" in created.text:
                hint += (
                    " Free Edition cannot create a catalog through the API without a storage "
                    "location: create it once in the workspace UI (Catalog > Create catalog > "
                    f"name {full_name!r}, Default storage), then re-run."
                )
        msg = (
            f"could not create {kind} {full_name}: "
            f"HTTP {created.status_code} {created.text[:300]}{hint}"
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
            "catalog": self._uc_ensure("catalogs", catalog, {"name": catalog}),
            "schema": self._uc_ensure(
                "schemas", f"{catalog}.{schema}", {"name": schema, "catalog_name": catalog}
            ),
            "volume": self._uc_ensure(
                "volumes",
                f"{catalog}.{schema}.{volume}",
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

    def list_directory(self, directory: PurePosixPath) -> list[tuple[PurePosixPath, bool]]:
        """The directory's own entries (not recursive), each with whether it is a directory."""
        return self._walk(directory, recursive=False)

    def list_files(self, directory: PurePosixPath) -> list[PurePosixPath]:
        """Every file under the directory, recursively (the Files API directory listing)."""
        return [p for p, is_dir in self._walk(directory, recursive=True) if not is_dir]

    def _walk(
        self, directory: PurePosixPath, *, recursive: bool
    ) -> list[tuple[PurePosixPath, bool]]:
        out: list[tuple[PurePosixPath, bool]] = []
        pending = [directory]
        prefix = self.root + "/"
        while pending:
            current = pending.pop()
            token: str | None = None
            while True:
                params = {"page_size": "1000"}
                if token:
                    params["page_token"] = token
                response = self._send(
                    "GET",
                    f"{self.host}/api/2.0/fs/directories{self._volume_path(current)}",
                    params=params,
                )
                if response.status_code == 404:
                    break
                if response.status_code != 200:
                    msg = (
                        f"could not list {current}: HTTP {response.status_code} "
                        f"{response.text[:200]}"
                    )
                    raise RuntimeError(msg)
                body = response.json()
                for item in body.get("contents", []):
                    full = str(item.get("path", ""))
                    relative = PurePosixPath(
                        full[len(prefix) :] if full.startswith(prefix) else full
                    )
                    is_dir = bool(item.get("is_directory"))
                    if is_dir and recursive:
                        pending.append(relative)
                    else:
                        out.append((relative, is_dir))
                token = body.get("next_page_token") or None
                if not token:
                    break
        return sorted(out)

    def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """One Files API call, retried with backoff on rate limiting and server errors.

        The workspace rate-limits the Files API under a backfill's write bursts (HTTP 429
        RESOURCE_EXHAUSTED); a payload must never be lost to that, so the call is retried a
        few times, honouring Retry-After, before the failure is reported.
        """
        return retrying_send(self._client, method, url, retries=_WRITE_RETRIES, **kwargs)

    def _ensure_directory(self, directory: str) -> None:
        with self._dir_lock:  # writes run on several threads; create each directory once
            if directory in self._known_dirs:
                return
            response = self._send("PUT", f"{self.host}/api/2.0/fs/directories{directory}")
            if response.status_code not in (200, 204):
                msg = (
                    f"could not create {directory}: HTTP {response.status_code} "
                    f"{response.text[:200]}"
                )
                raise RuntimeError(msg)
            self._known_dirs.add(directory)

    def ensure_directory(self, path: PurePosixPath) -> None:
        """Create a landing directory (and its parents) if missing; idempotent."""
        self._ensure_directory(self._volume_path(path))

    def read_bytes(self, path: PurePosixPath) -> bytes | None:
        response = self._send("GET", self._files_url(path))
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            msg = f"could not read {path}: HTTP {response.status_code} {response.text[:200]}"
            raise RuntimeError(msg)
        return response.content

    def write_bytes(self, path: PurePosixPath, body: bytes) -> None:
        self._ensure_directory(self._volume_path(path.parent))
        response = self._send(
            "PUT",
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
    # The last ingest date the payload was fetched and found the same (or landed). Indexes
    # written before this field existed fall back to ingest_date.
    checked_date: str = ""
    # False when the ingestor found the payload half-written (ingest/complete.py): it is fetched
    # again on every run, settled or not, until a whole one lands. Older indexes read as complete.
    complete: bool = True

    @property
    def last_checked(self) -> date:
        return date.fromisoformat(self.checked_date or self.ingest_date)


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
    # Which request this was, so the run summary can count by endpoint.
    endpoint: str = ""
    key: str = ""


@dataclass(frozen=True)
class WriteFailure:
    endpoint: str
    key: str
    error: BaseException


def load_index(backend: Backend, scope: Scope) -> dict[str, IndexEntry]:
    """The scope's index, or an empty one with a warning when the file cannot be read as an index.

    A write cut off midway (the index is rewritten in place) or a hand edit used to crash every
    run of the scope with a traceback; an empty index only costs the re-fetch of what the window
    covers, and the run's flush rewrites the file whole (#415). ``reindex`` rebuilds it from the
    sidecars without a fetch.
    """
    text = backend.read_bytes(scope.index_path())
    if not text:
        return {}
    try:
        raw = json.loads(text)
        if not isinstance(raw, dict):
            raise TypeError("the index is not an object")
        out: dict[str, IndexEntry] = {}
        bad = 0
        for key, value in raw.items():
            try:
                out[key] = IndexEntry(**value)
            except TypeError:
                bad += 1
        if bad:
            print(f"  warning: {scope.index_path()} has {bad} unreadable entries; they re-land")
        return out
    except (ValueError, TypeError) as exc:
        print(f"  warning: {scope.index_path()} is not readable ({exc}); treating it as empty")
        return {}


def reindex(backend: Backend, scope: Scope) -> dict[str, IndexEntry]:
    """Rebuild a scope's index from the sidecars next to its payloads, and write it.

    Every ``*.meta.json`` under the scope's folder names a landed payload: its hash and size are
    the sidecar's, its ingest date is the folder it sits in, and its key is the one the sidecar
    carries (older sidecars: the file's stem). The newest landing of each key wins, as the
    live index would have it.
    """
    folder = scope.index_path().parent
    entries: dict[str, IndexEntry] = {}
    for path in backend.list_files(folder):
        name = path.name
        if not name.endswith(".meta.json"):
            continue
        text = backend.read_bytes(path)
        if not text:
            continue
        try:
            meta = json.loads(text)
        except ValueError:
            continue
        payload = path.with_name(name[: -len(".meta.json")] + ".json")
        key = str(meta.get("key") or payload.stem)
        ingest_date = path.parent.name
        entry = IndexEntry(
            sha256=str(meta.get("sha256", "")),
            path=payload.as_posix(),
            ingest_date=ingest_date,
            size_bytes=int(meta.get("size_bytes", 0)),
            checked_date=ingest_date,
        )
        previous = entries.get(key)
        if previous is None or entry.ingest_date >= previous.ingest_date:
            entries[key] = entry
    payload_json = {k: asdict(v) for k, v in sorted(entries.items())}
    backend.write_bytes(
        scope.index_path(), (json.dumps(payload_json, indent=2) + "\n").encode("utf-8")
    )
    return entries


class Landing:
    """Writes payloads and sidecars through a backend and keeps the per-scope indexes.

    With ``workers`` > 1 the writes run on a small thread pool so uploads overlap the
    mandatory pause between requests; ``flush()`` waits for them and reports failures. The
    indexes are also written every ``flush_every`` landings, so a run that dies keeps most of
    what it landed; the failures those writes find are reported by the next ``flush()``.
    """

    def __init__(
        self,
        backend: Backend,
        *,
        ingest_date: date,
        full_refresh: bool = False,
        workers: int = 1,
        flush_every: int = FLUSH_EVERY,
        resettle_since: date | None = None,
        run_id: str | None = None,
        request_stats: Callable[[], object] | None = None,
    ) -> None:
        self.backend = backend
        self.ingest_date = ingest_date
        self.full_refresh = full_refresh
        self.flush_every = flush_every
        # Stamped on every sidecar: the run, and what the request that produced the payload cost
        # (``request_stats`` returns the client's last RequestStats, or None).
        self.run_id = run_id
        self.request_stats = request_stats
        # A sweep: games played on or after this date are fetched again even when settled.
        self.resettle_since = resettle_since
        self._indexes: dict[Scope, dict[str, IndexEntry]] = {}
        self._dirty: set[Scope] = set()
        self._pool = ThreadPoolExecutor(max_workers=workers) if workers > 1 else None
        self._pending: list[tuple[Scope, str, Future[None]]] = []
        self._since_flush = 0
        self._deferred: list[WriteFailure] = []

    def _index(self, scope: Scope) -> dict[str, IndexEntry]:
        if scope not in self._indexes:
            self._indexes[scope] = load_index(self.backend, scope)
        return self._indexes[scope]

    def has_landed(self, scope: Scope, key: str) -> bool:
        """Whether the key has ever landed for the scope (a history run lands each key once)."""
        return not self.full_refresh and key in self._index(scope)

    def already_landed_today(self, scope: Scope, key: str) -> bool:
        """True when this key was landed on this ingest date and no full refresh was asked."""
        if self.full_refresh:
            return False
        entry = self._index(scope).get(key)
        return entry is not None and entry.last_checked == self.ingest_date

    def settled(self, scope: Scope, key: str, played: date, days: int = SETTLE_DAYS) -> bool:
        """True when a game's payload was landed, whole, at least ``days`` after the game.

        A full refresh treats nothing as settled; a resettle sweep treats nothing played on or
        after its date as settled; a payload landed half-written is never settled.
        """
        if self.full_refresh:
            return False
        if self.resettle_since is not None and played >= self.resettle_since:
            return False
        entry = self._index(scope).get(key)
        if entry is None or not entry.complete:
            return False
        return entry.last_checked >= played + timedelta(days=days)

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
        complete: bool = True,
    ) -> LandResult:
        sha = payload_hash(body)
        path = landing_key(
            scope.source, scope.endpoint, scope.league, scope.season, self.ingest_date, key
        )
        index = self._index(scope)
        previous = index.get(key)
        if previous is not None and previous.sha256 == sha and not self.full_refresh:
            # Same bytes: nothing to write, but the payload was confirmed today.
            index[key] = replace(
                previous, checked_date=self.ingest_date.isoformat(), complete=complete
            )
            self._dirty.add(scope)
            return LandResult("unchanged", PurePosixPath(previous.path), sha, scope.endpoint, key)

        stats = self.request_stats() if self.request_stats is not None else None
        sidecar = Sidecar.for_response(
            url=url,
            params=params,
            status=status,
            body=body,
            fetched_at=fetched_at,
            latency_ms=getattr(stats, "latency_ms", None),
            attempts=getattr(stats, "attempts", None),
            run_id=self.run_id,
            key=key,
        )
        sidecar_bytes = sidecar.model_dump_json(indent=2).encode("utf-8")
        sidecar_path = sidecar.sidecar_path(path)
        if self._pool is None:
            self.backend.write_bytes(path, body)
            self.backend.write_bytes(sidecar_path, sidecar_bytes)
        else:
            write = self.backend.write_bytes
            self._pending.append((scope, key, self._pool.submit(write, path, body)))
            self._pending.append(
                (scope, key, self._pool.submit(write, sidecar_path, sidecar_bytes))
            )
        index[key] = IndexEntry(
            sha256=sha,
            path=path.as_posix(),
            ingest_date=self.ingest_date.isoformat(),
            size_bytes=len(body),
            checked_date=self.ingest_date.isoformat(),
            complete=complete,
        )
        self._dirty.add(scope)
        self._since_flush += 1
        if self.flush_every and self._since_flush >= self.flush_every:
            self._deferred.extend(self._settle())
        return LandResult("landed", path, sha, scope.endpoint, key)

    def flush(self) -> list[WriteFailure]:
        """Wait for queued writes, drop failed keys from the indexes, persist the indexes.

        Returns every write failure since the last call, including those an interim write of
        the indexes found.
        """
        failures = [*self._deferred, *self._settle()]
        self._deferred = []
        return failures

    def _settle(self) -> list[WriteFailure]:
        self._since_flush = 0
        failures: list[WriteFailure] = []
        failed_keys: set[tuple[Scope, str]] = set()
        for scope, key, future in self._pending:
            error = future.exception()
            if error is not None and (scope, key) not in failed_keys:
                failed_keys.add((scope, key))
                failures.append(WriteFailure(scope.endpoint, key, error))
        self._pending.clear()
        for scope, key in failed_keys:
            self._indexes.get(scope, {}).pop(key, None)  # it is not landed; re-fetch next run
        for scope in sorted(self._dirty, key=lambda s: (s.source, s.endpoint, s.league, s.season)):
            payload = {k: asdict(v) for k, v in sorted(self._indexes[scope].items())}
            self.backend.write_bytes(
                scope.index_path(), (json.dumps(payload, indent=2) + "\n").encode("utf-8")
            )
        self._dirty.clear()
        return failures

    def close(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=True)
