"""Is a landed game payload whole?

A payload can arrive before the source has finished writing it: ESPN publishes a game summary
before its box score has players (ADR 0005), the stats API posts a box score before the last
corrections, a play-by-play can be cut short. ``Landing.settled`` leaves a payload alone once it
was landed two days after the game; a payload these predicates call incomplete is never
settled, so the next run fetches it again until a whole one lands. The predicates are loose on
purpose: they tell an empty or half-written payload from a whole one, not a correct one from a
wrong one (the quality checks do that in the lakehouse).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any


def _json(body: bytes) -> Any:
    try:
        return json.loads(body)
    except ValueError:
        return None


def stats_box_complete(body: bytes) -> bool:
    """Both teams have players in the traditional or advanced box score."""
    data = _json(body)
    if not isinstance(data, dict):
        return False
    box = next(
        (v for k, v in data.items() if k.startswith("boxScore") and isinstance(v, dict)), None
    )
    if box is None:
        return False
    return all(
        isinstance(box.get(side), dict) and bool(box[side].get("players"))
        for side in ("homeTeam", "awayTeam")
    )


def stats_playbyplay_complete(body: bytes) -> bool:
    """The game has actions (an empty feed is the API not having written the game yet)."""
    data = _json(body)
    actions = data.get("game", {}).get("actions") if isinstance(data, dict) else None
    return isinstance(actions, list) and bool(actions)


def stats_rows_complete(body: bytes) -> bool:
    """A resultSets payload with at least one row (a shot chart, a game log)."""
    data = _json(body)
    sets = data.get("resultSets") if isinstance(data, dict) else None
    if not isinstance(sets, list) or not sets:
        return False
    first = sets[0]
    return isinstance(first, dict) and bool(first.get("rowSet"))


def espn_summary_complete(body: bytes) -> bool:
    """The summary's box score has both teams' player statistics."""
    data = _json(body)
    players = data.get("boxscore", {}).get("players") if isinstance(data, dict) else None
    if not isinstance(players, list) or len(players) < 2:
        return False
    return all(isinstance(team, dict) and bool(team.get("statistics")) for team in players)


# By endpoint: the payloads a run fetches per game and settles. Anything else is whole as landed.
STATS: dict[str, Callable[[bytes], bool]] = {
    "boxscoretraditionalv3": stats_box_complete,
    "boxscoreadvancedv3": stats_box_complete,
    "playbyplayv3": stats_playbyplay_complete,
    "shotchartdetail": stats_rows_complete,
}
ESPN: dict[str, Callable[[bytes], bool]] = {"summary": espn_summary_complete}


def is_complete(table: dict[str, Callable[[bytes], bool]], endpoint: str, body: bytes) -> bool:
    check = table.get(endpoint)
    return True if check is None else check(body)
