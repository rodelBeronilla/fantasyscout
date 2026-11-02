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


def test_without_a_health_file_the_season_is_unknown_and_the_in_season_limit_applies() -> None:
    """#400: an unreadable health file no longer buys the lenient 72 h."""
    verdict = watchdog.decide(_latest("2026-11-01T00:00:00+00:00"), None, NOW)  # 36 h old
    assert verdict.stale and "season unknown" in verdict.line and "limit 30 h" in verdict.line
    assert not watchdog.decide(_latest("2026-11-02T00:00:00+00:00"), None, NOW).stale


def test_a_new_build_over_old_stats_is_stale_in_season() -> None:
    """#400: the evening light build is new, but the stats feed stopped landing three days ago."""
    health = {
        "feeds": [
            {
                "league": "nba",
                "feed": "Game logs",
                "is_core": True,
                "in_season": True,
                "last_landed": "2026-10-30",
                "max_age_days": 2,
            },
            {
                "league": "nba",
                "feed": "Injury reports",
                "is_core": True,
                "in_season": True,
                "last_landed": "2026-11-02",
                "max_age_days": 1,
            },
            {
                "league": "wnba",
                "feed": "Game logs",
                "is_core": True,
                "in_season": False,
                "last_landed": "2026-10-01",
                "max_age_days": 2,
            },
            {
                "league": "nba",
                "feed": "Headlines",
                "is_core": False,
                "in_season": True,
                "last_landed": "2026-10-20",
                "max_age_days": 2,
            },
        ]
    }
    verdict = watchdog.decide(_latest("2026-11-02T03:00:00+00:00"), health, NOW)
    assert verdict.stale
    assert "nba Game logs last landed 2026-10-30 (3 days, allowed 2)" in verdict.line
    # the off-season league and the optional feed do not count
    assert "wnba" not in verdict.line.split("old:")[1] and "Headlines" not in verdict.line
    # the same feed landed yesterday: fresh
    health["feeds"][0]["last_landed"] = "2026-11-01"  # type: ignore[index]
    assert not watchdog.decide(_latest("2026-11-02T03:00:00+00:00"), health, NOW).stale


def test_a_pinned_rollback_is_reported_as_pinned_not_stale() -> None:
    """#400: a rollback holds the site on purpose; the verdict names the pin, not the pipeline."""
    latest = {
        "build_id": "20261028T020000Z-abc1234",
        "created_at": "2026-10-28T02:00:00+00:00",  # five days old
        "pinned": True,
        "rolled_back_at": "2026-11-01T09:00:00+00:00",
        "rolled_back_from": "20261101T020658Z-def5678",
    }
    verdict = watchdog.decide(latest, _health("nba"), NOW)
    assert not verdict.stale
    assert verdict.line.startswith("pinned:") and "since 2026-11-01T09:00:00+00:00" in verdict.line
    assert "fs-export unpin" in verdict.line


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
