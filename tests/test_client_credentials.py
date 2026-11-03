"""The ingest signs its requests as a service principal with OAuth client credentials (#371)."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import pytest

from ingest import land, probe
from ingest.store import ClientCredentials, VolumeBackend, credentials_from_env


class Workspace:
    """A fake token endpoint and Files API that record what they were asked."""

    def __init__(self) -> None:
        self.exchanges: list[dict[str, str]] = []
        self.bearers: list[str] = []
        self.expires_in = 3600
        self.reject_first_bearer = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oidc/v1/token":
            basic = request.headers["Authorization"].removeprefix("Basic ")
            user, secret = base64.b64decode(basic).decode().split(":", 1)
            form = dict(pair.split("=") for pair in request.content.decode().split("&"))
            self.exchanges.append({"client": user, "secret": secret, **form})
            n = len(self.exchanges)
            return httpx.Response(
                200, json={"access_token": f"tok{n}", "expires_in": self.expires_in}
            )
        bearer = request.headers.get("Authorization", "")
        self.bearers.append(bearer)
        if self.reject_first_bearer and bearer == "Bearer tok1":
            return httpx.Response(401, text="expired")
        if request.method == "GET" and "/unity-catalog/catalogs" in request.url.path:
            return httpx.Response(200, json={"catalogs": []})
        return httpx.Response(204)


def test_the_principal_exchanges_once_and_signs_every_request() -> None:
    ws = Workspace()
    transport = httpx.MockTransport(ws.handler)
    auth = ClientCredentials(
        "https://dbc-1.cloud.databricks.com/?o=1", "app-id", "s3cret", transport=transport
    )
    client = httpx.Client(auth=auth, transport=transport)
    for _ in range(3):
        assert (
            client.put("https://dbc-1.cloud.databricks.com/api/2.0/fs/files/x").status_code == 204
        )
    assert ws.exchanges == [
        {
            "client": "app-id",
            "secret": "s3cret",
            "grant_type": "client_credentials",
            "scope": "all-apis",
        }
    ]
    assert ws.bearers == ["Bearer tok1"] * 3
    assert auth.exchanges == 1


def test_the_token_is_renewed_before_it_expires() -> None:
    ws = Workspace()
    ws.expires_in = 600
    now = [1000.0]
    transport = httpx.MockTransport(ws.handler)
    auth = ClientCredentials(
        "dbc-1.cloud.databricks.com", "a", "s", transport=transport, clock=lambda: now[0]
    )
    client = httpx.Client(auth=auth, transport=transport)
    client.put("https://dbc-1.cloud.databricks.com/api/2.0/fs/files/x")
    now[0] += 200  # 400 s left, more than the margin
    client.put("https://dbc-1.cloud.databricks.com/api/2.0/fs/files/x")
    assert len(ws.exchanges) == 1
    now[0] += 150  # 250 s left, inside the 300 s margin
    client.put("https://dbc-1.cloud.databricks.com/api/2.0/fs/files/x")
    assert len(ws.exchanges) == 2
    assert ws.bearers == ["Bearer tok1", "Bearer tok1", "Bearer tok2"]


def test_a_401_fetches_a_fresh_token_and_retries_once() -> None:
    ws = Workspace()
    ws.reject_first_bearer = True
    transport = httpx.MockTransport(ws.handler)
    auth = ClientCredentials("dbc-1.cloud.databricks.com", "a", "s", transport=transport)
    client = httpx.Client(auth=auth, transport=transport)
    assert client.put("https://dbc-1.cloud.databricks.com/api/2.0/fs/files/x").status_code == 204
    assert ws.bearers == ["Bearer tok1", "Bearer tok2"]


def test_refused_credentials_fail_with_the_reason() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(401, text="invalid_client"))
    auth = ClientCredentials("dbc-1.cloud.databricks.com", "a", "wrong", transport=transport)
    with pytest.raises(RuntimeError, match="refused: HTTP 401 invalid_client"):
        auth.token()


def test_the_backend_signs_with_the_principal_when_given_one(tmp_path: Path) -> None:
    ws = Workspace()
    transport = httpx.MockTransport(ws.handler)
    auth = ClientCredentials("dbc-1.cloud.databricks.com", "a", "s", transport=transport)
    backend = VolumeBackend("dbc-1.cloud.databricks.com", "", transport=transport, auth=auth)
    backend.write_bytes(__import__("pathlib").PurePosixPath("landing/x.json"), b"{}")
    assert ws.bearers and all(b == "Bearer tok1" for b in ws.bearers)
    backend.close()


def test_the_environment_picks_the_principal_then_the_token(tmp_path: Path) -> None:
    both = {
        "DATABRICKS_HOST": "dbc-1.cloud.databricks.com",
        "DATABRICKS_CLIENT_ID": "a",
        "DATABRICKS_CLIENT_SECRET": "s",
        "DATABRICKS_TOKEN": "t",
    }
    assert isinstance(credentials_from_env(both), ClientCredentials)
    assert credentials_from_env({"DATABRICKS_HOST": "h", "DATABRICKS_CLIENT_ID": "a"}) is None
    token_only = {"DATABRICKS_HOST": "dbc-1.cloud.databricks.com", "DATABRICKS_TOKEN": "t"}
    assert isinstance(land.make_backend("volume", tmp_path, token_only), VolumeBackend)
    assert isinstance(land.make_backend("volume", tmp_path, both), VolumeBackend)
    with pytest.raises(SystemExit, match="DATABRICKS_CLIENT_ID"):
        land.make_backend("volume", tmp_path, {"DATABRICKS_HOST": "h"})


def test_the_probe_target_uses_a_token_from_the_principal(monkeypatch: pytest.MonkeyPatch) -> None:
    ws = Workspace()
    transport = httpx.MockTransport(ws.handler)
    monkeypatch.setattr(
        probe,
        "credentials_from_env",
        lambda env: ClientCredentials(
            env["DATABRICKS_HOST"],
            env["DATABRICKS_CLIENT_ID"],
            env["DATABRICKS_CLIENT_SECRET"],
            transport=transport,
        ),
    )
    target = probe.databricks_target(
        {
            "DATABRICKS_HOST": "dbc-1.cloud.databricks.com",
            "DATABRICKS_CLIENT_ID": "a",
            "DATABRICKS_CLIENT_SECRET": "s",
        }
    )
    assert target is not None
    assert target.headers["Authorization"] == "Bearer tok1"
    assert json.loads(json.dumps(ws.exchanges))[0]["client"] == "a"
