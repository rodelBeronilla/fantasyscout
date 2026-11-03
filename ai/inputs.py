"""The players a week's notes are about, chosen without the model (SPEC.md, step 1).

From the board's daily history (``fct_board_history``), per league, between the latest snapshot
and the one ``days`` before it:

- the ``top`` biggest risers and fallers in rest-of-season value;
- every change of availability group (healthy, questionable, out ...);
- projected-minutes shifts beyond 1.5 standard deviations of the week's shifts.

Each input carries the numbers the note may use, rounded as the note should state them, and the
row they come from. The validator (validate.py) checks the note against exactly these.
"""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent

# metric -> (the board history's column, decimals a note states it with)
METRICS: dict[str, tuple[str, int]] = {
    "value_rest_of_season": ("value_rest_of_season", 1),
    "rank": ("rank_total", 0),
    "projected_minutes": ("proj_minutes_pg", 1),
    "projected_points": ("proj_points_pg", 1),
    "projected_rebounds": ("proj_rebounds_total_pg", 1),
    "projected_assists": ("proj_assists_pg", 1),
    "availability_share": ("availability_multiplier", 2),
    "games_remaining": ("games_remaining", 0),
}
MINUTES_Z = 1.5
# how the model sees each metric: a small model writes what it reads, so it reads plain words
LABELS: dict[str, str] = {
    "value_rest_of_season": "rest-of-season value",
    "rank": "board rank",
    "projected_minutes": "projected minutes",
    "projected_points": "projected points",
    "projected_rebounds": "projected rebounds",
    "projected_assists": "projected assists",
    "availability_share": "share of games expected to play",
    "games_remaining": "games left",
}
PARTS = ("before", "after", "change")


def model_view(inp: dict[str, Any]) -> dict[str, Any]:
    """What the model is given for one player: the same numbers under plain names."""
    return {
        "player_id": inp["player_id"],
        "player": inp["name"],
        "team": inp["team"],
        "why picked": inp["reason"],
        "injury status before": inp.get("injury_before") or "healthy",
        "injury status after": inp.get("injury_after") or "healthy",
        "row_ref": inp["row_ref"],
        "numbers": {LABELS.get(m, m): v for m, v in inp["metrics"].items()},
    }


def connect(source: str | None = None) -> Any:
    """The notebooks' connection (notebooks/fs.py): the published build, or the local dbt file."""
    spec = importlib.util.spec_from_file_location("fs", ROOT / "notebooks" / "fs.py")
    if spec is None or spec.loader is None:
        msg = "notebooks/fs.py is missing"
        raise RuntimeError(msg)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.connect(source)


def _round(value: Any, decimals: int) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), decimals)


def snapshot_dates(con: Any, league: str) -> list[str]:
    rows = con.execute(
        "select distinct cast(snapshot_date as varchar) from fct_board_history"
        " where league = ? order by 1",
        [league],
    ).fetchall()
    return [r[0] for r in rows]


def select(
    con: Any, league: str, *, as_of: str | None = None, days: int = 7, top: int = 8
) -> dict[str, Any]:
    """The week's inputs for one league: the two snapshots compared and the players picked."""
    dates = snapshot_dates(con, league)
    after = as_of if as_of in dates else (dates[-1] if dates else None)
    if after is None:
        return {"league": league, "before": None, "after": None, "players": []}
    earlier = [d for d in dates if d <= _minus_days(after, days)]
    before = earlier[-1] if earlier else (dates[0] if dates[0] < after else None)
    if before is None:
        return {"league": league, "before": None, "after": after, "players": []}
    cols = sorted({c for c, _ in METRICS.values()} | {"injury_status", "injury_group"})
    pick = ", ".join(f"a.{c} as a_{c}, b.{c} as b_{c}" for c in cols)
    rows = con.execute(
        f"""
        select a.player_id, coalesce(m.full_name, a.player_id) as full_name,
               coalesce(m.team_abbreviation, '') as team, {pick}
        from fct_board_history as a
        join fct_board_history as b
          on b.league = a.league and b.player_id = a.player_id
         and cast(b.snapshot_date as varchar) = ?
        left join mart_board as m on m.league = a.league and m.player_id = a.player_id
        where a.league = ? and cast(a.snapshot_date as varchar) = ?
        """,
        [before, league, after],
    ).fetchall()
    names = [d[0] for d in con.description]
    records = [dict(zip(names, r, strict=True)) for r in rows]

    def delta(r: dict[str, Any], col: str) -> float:
        a, b = r.get(f"a_{col}"), r.get(f"b_{col}")
        return float(a) - float(b) if a is not None and b is not None else 0.0

    chosen: dict[str, str] = {}
    by_value = sorted(records, key=lambda r: delta(r, "value_rest_of_season"))
    for r in reversed(by_value[-top:]):
        if delta(r, "value_rest_of_season") > 0:
            chosen.setdefault(r["player_id"], "riser")
    for r in by_value[:top]:
        if delta(r, "value_rest_of_season") < 0:
            chosen.setdefault(r["player_id"], "faller")
    for r in records:
        if (r.get("a_injury_group") or "healthy") != (r.get("b_injury_group") or "healthy"):
            chosen.setdefault(r["player_id"], "availability")
    shifts = [delta(r, "proj_minutes_pg") for r in records]
    if len(shifts) > 2:
        mean = sum(shifts) / len(shifts)
        sd = math.sqrt(sum((s - mean) ** 2 for s in shifts) / (len(shifts) - 1))
        for r, s in zip(records, shifts, strict=True):
            if sd > 0 and abs(s - mean) / sd > MINUTES_Z:
                chosen.setdefault(r["player_id"], "minutes")

    players = []
    for r in records:
        reason = chosen.get(r["player_id"])
        if not reason:
            continue
        metrics: dict[str, dict[str, float | None]] = {}
        for metric, (col, digits) in METRICS.items():
            b, a = _round(r.get(f"b_{col}"), digits), _round(r.get(f"a_{col}"), digits)
            if a is None and b is None:
                continue
            change = round(a - b, digits) if a is not None and b is not None else None
            metrics[metric] = {"before": b, "after": a, "change": change}
        players.append(
            {
                "player_id": str(r["player_id"]),
                "name": r["full_name"],
                "team": r["team"],
                "reason": reason,
                "row_ref": f"fct_board_history/{league}/{r['player_id']}/{before}..{after}",
                "injury_before": r.get("b_injury_status"),
                "injury_after": r.get("a_injury_status"),
                "metrics": metrics,
            }
        )
    order = {"riser": 0, "faller": 1, "availability": 2, "minutes": 3}
    players.sort(
        key=lambda p: (
            order[p["reason"]],
            -abs((p["metrics"].get("value_rest_of_season") or {}).get("change") or 0),
        )
    )
    return {"league": league, "before": before, "after": after, "players": players}


def _minus_days(date: str, days: int) -> str:
    from datetime import date as _date
    from datetime import timedelta

    return (_date.fromisoformat(date) - timedelta(days=days)).isoformat()
