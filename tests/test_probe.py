from __future__ import annotations

import json
import random

import httpx

from ingest.http import Throttle, ThrottledClient
from ingest.probe import (
    DEFAULT_TARGETS,
    Target,
    databricks_target,
    run_probe,
    to_json,
    to_markdown,
)


def _client(handler: object) -> ThrottledClient:
    return ThrottledClient(
        Throttle(max_retries=0),
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
        sleep=lambda _: None,
        clock=lambda: 0.0,
        rng=random.Random(0),
    )


def test_reports_each_target_with_json_shape_check() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "stats.wnba.com" in str(request.url):
            assert request.headers["Referer"] == "https://www.wnba.com/"
            return httpx.Response(200, json={"resultSets": []})
        if "stats.nba.com" in str(request.url):
            return httpx.Response(403, text="blocked")
        if "espn" in str(request.url) and "wnba" in str(request.url):
            return httpx.Response(200, json={"something": "else"})
        raise httpx.ConnectTimeout("timed out")

    results = run_probe(DEFAULT_TARGETS, client=_client(handler))
    by_name = {r.name: r for r in results}
    assert by_name["stats-wnba"].ok and by_name["stats-wnba"].status == 200
    assert not by_name["stats-nba"].ok and by_name["stats-nba"].detail == "HTTP 403"
    assert not by_name["espn-wnba"].ok and "without 'events'" in by_name["espn-wnba"].detail
    assert not by_name["espn-nba"].ok and "ConnectTimeout" in by_name["espn-nba"].detail
    assert by_name["espn-nba"].status is None


def test_databricks_target_requires_both_env_values() -> None:
    assert databricks_target({}) is None
    assert databricks_target({"DATABRICKS_HOST": "https://x"}) is None
    target = databricks_target(
        {"DATABRICKS_HOST": "https://dbc-1.cloud.databricks.com/", "DATABRICKS_TOKEN": "secret"}
    )
    assert target is not None
    assert target.url == "https://dbc-1.cloud.databricks.com/api/2.1/unity-catalog/catalogs"
    assert "secret" not in target.url
    assert target.headers["Authorization"] == "Bearer secret"


def test_workspace_origin_strips_paths_and_queries() -> None:
    from ingest.probe import workspace_origin

    assert (
        workspace_origin("https://dbc-1.cloud.databricks.com/")
        == "https://dbc-1.cloud.databricks.com"
    )
    assert (
        workspace_origin("https://dbc-1.cloud.databricks.com/?o=123#x")
        == "https://dbc-1.cloud.databricks.com"
    )
    assert (
        workspace_origin("https://dbc-1.cloud.databricks.com/browse/folders/1?o=2")
        == "https://dbc-1.cloud.databricks.com"
    )
    assert workspace_origin("dbc-1.cloud.databricks.com") == "https://dbc-1.cloud.databricks.com"
    assert workspace_origin("  ") == ""


def test_redirects_are_reported_with_their_destination() -> None:
    target = Target(name="t", url="https://example.test/api", expect="k")
    results = run_probe(
        [target],
        client=_client(
            lambda _: httpx.Response(303, headers={"location": "https://example.test/login?next=x"})
        ),
    )
    assert results[0].ok is False
    assert results[0].detail == "HTTP 303 redirect to example.test/login"


def test_reports_never_contain_headers() -> None:
    target = Target(
        name="t", url="https://example.test/x", expect="k", headers={"Authorization": "Bearer s"}
    )
    results = run_probe([target], client=_client(lambda _: httpx.Response(200, json={"k": 1})))
    assert "Bearer" not in to_json(results)
    assert "Bearer" not in to_markdown(results)
    assert json.loads(to_json(results))[0]["ok"] is True
    assert "| t | yes | 200 |" in to_markdown(results)
