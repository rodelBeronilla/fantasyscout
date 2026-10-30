"""ESPN's news headlines for both leagues: what is being reported about which players.

ESPN's news feed lists the latest 50 articles per league, each tagged with the athletes it is
about (ESPN athlete ids, which the player crosswalk links to the league's). The site shows a
headline, its date and a link to the story on ESPN, never the story, so only those fields land
(no description, images or byline). A run lands the feed under the day and the Eastern hour, so
the morning's and the evening's headlines are both kept.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from ingest.http import CircuitOpenError, ThrottledClient
from ingest.landing import League
from ingest.run import RunSummary
from ingest.store import Landing, Scope

URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/{league}/news"
EASTERN = ZoneInfo("America/New_York")


def trim_articles(body: bytes) -> list[dict[str, Any]]:
    """Each article reduced to its headline, date, link and tagged athletes."""
    out: list[dict[str, Any]] = []
    for a in json.loads(body).get("articles") or []:
        athletes = [
            {
                "id": c.get("athleteId") or (c.get("athlete") or {}).get("id"),
                "name": c.get("description"),
            }
            for c in a.get("categories") or []
            if c.get("type") == "athlete"
        ]
        out.append(
            {
                "id": a.get("id"),
                "type": a.get("type"),
                "headline": a.get("headline"),
                "published": a.get("published"),
                "url": ((a.get("links") or {}).get("web") or {}).get("href"),
                "athletes": [x for x in athletes if x["id"]],
            }
        )
    return out


@dataclass
class EspnNewsIngestor:
    """Lands the league's latest headlines into an existing run summary."""

    client: ThrottledClient
    landing: Landing
    league: League
    season: str
    now: datetime | None = None

    def land_into(self, summary: RunSummary) -> None:
        now = self.now or datetime.now(UTC)
        key = f"{now.astimezone(EASTERN):%Y-%m-%dT%H}"
        url = URL.format(league=self.league)
        scope = Scope("espn", "news", self.league, self.season)
        try:
            if self.landing.already_landed_today(scope, key):
                summary.record(None)
                return
            response = self.client.get(url, params={"limit": "50"})
            if response.status_code != 200:
                summary.fail("news", key, RuntimeError(f"HTTP {response.status_code}"))
                return
            body = json.dumps(
                {"articles": trim_articles(response.content)}, ensure_ascii=False
            ).encode()
            result = self.landing.land(
                scope, key, body, url=url, params={"limit": "50"}, status=200, fetched_at=now
            )
            summary.record(result)
        except CircuitOpenError as exc:
            summary.aborted = str(exc)
        except Exception as exc:  # the news never fails the run
            summary.fail("news", key, exc)
