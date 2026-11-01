"""The publish watchdog judges the live build's age against the season's SLA (#241)."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx

from ops import watchdog

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


def _latest(created_at: str) -> dict[str, object]:
    return {"build_id": "20261101T020658Z-abc1234", "created_at": created_at}


def _health(*in_season: str) -> dict[str, object]:
    return {
        "feeds": [
            {"league": "nba", "in_season": "nba" in in_season},
            {"league": "wnba", "in_season": "wnba" in in_season},
        ]
    }


def test_a_recent_build_is_fresh_in_season() -> None:
    verdict = watchdog.decide(_latest("2026-11-02T02:00:00+00:00"), _health("nba"), NOW)
    assert not verdict.stale
    assert "fresh" in verdict.line and "in season (nba)" in verdict.line


def test_a_missed_day_is_stale_in_season_but_tolerated_off_season() -> None:
    latest = _latest("2026-10-31T20:00:00+00:00")  # 40 h old
    assert watchdog.decide(latest, _health("wnba"), NOW).stale
    assert not watchdog.decide(latest, _health(), NOW).stale
    assert watchdog.decide(_latest("2026-10-29T12:00:00+00:00"), _health(), NOW).stale


def test_a_missing_or_malformed_pointer_is_stale() -> None:
    assert watchdog.decide(None, None, NOW).stale
    assert watchdog.decide({"build_id": "x"}, None, NOW).stale
    # Without a health file nothing says a league is in season, so the longer limit applies.
    assert not watchdog.decide(_latest("2026-11-01T00:00:00+00:00"), None, NOW).stale


def test_a_naive_timestamp_is_read_as_utc() -> None:
    verdict = watchdog.decide(_latest("2026-11-02T10:00:00"), _health("nba"), NOW)
    assert not verdict.stale and "2.0 h old" in verdict.line


def test_check_reads_the_pointer_then_the_health_file(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/data/latest.json":
            return httpx.Response(200, json=_latest("2026-11-02T08:00:00+00:00"))
        if request.url.path.endswith("/health.json"):
            return httpx.Response(200, json=_health("nba"))
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def client(**kwargs: object) -> httpx.Client:
        return real_client(transport=transport, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(watchdog.httpx, "Client", client)
    verdict = watchdog.check("https://example.org/", NOW)
    assert not verdict.stale and "in season (nba)" in verdict.line


def test_check_reports_a_site_that_does_not_answer(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    real_client = httpx.Client
    monkeypatch.setattr(
        watchdog.httpx,
        "Client",
        lambda **kwargs: real_client(transport=transport, **kwargs),  # type: ignore[arg-type]
    )
    verdict = watchdog.check("https://example.org", NOW)
    assert verdict.stale and "no build pointer" in verdict.line


def test_main_exit_status(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(watchdog, "check", lambda site: watchdog.Verdict(False, "fresh"))
    assert watchdog.main(["--site", "https://example.org"]) == 0
    monkeypatch.setattr(watchdog, "check", lambda site: watchdog.Verdict(True, "stale"))
    assert watchdog.main(["--site", "https://example.org"]) == 2
