"""One JSON file per player, so a player page loads one small file (SPEC.md, "Export step").

The file carries what the Player page shows: the biography and team stints, a line per
season, the full game log, the rolling averages for the current season, the category
z-scores, the board row, and the current season's shots with the league's zone averages to
compare against. Everything is derived from gold tables already pulled for the build, through
an in-memory DuckDB, so the shaping is one set of SQL for both engines.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import duckdb
import pyarrow as pa

from export.encode import rows_of

BOX = (
    "minutes",
    "points",
    "rebounds_total",
    "assists",
    "steals",
    "blocks",
    "turnovers",
    "field_goals_made",
    "field_goals_attempted",
    "three_pointers_made",
    "three_pointers_attempted",
    "free_throws_made",
    "free_throws_attempted",
)


class PlayerFiles:
    """Builds every player's file from the gold tables of one build."""

    def __init__(self, tables: dict[str, pa.Table]) -> None:
        self._con = duckdb.connect()
        self._names = set(tables)
        for name, table in tables.items():
            self._con.register(name, table)

    def close(self) -> None:
        self._con.close()

    def _rows(self, sql: str) -> list[dict[str, Any]]:
        return rows_of(self._con.sql(sql).to_arrow_table())

    def _grouped(
        self, sql: str, key: str = "player_id"
    ) -> dict[tuple[str, str], list[dict[str, Any]]]:
        groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for row in self._rows(sql):
            groups[(row["league"], str(row[key]))].append(row)
        return groups

    def build(self) -> dict[tuple[str, str], dict[str, Any]]:
        """{(league, player_id): file} for every player in dim_player."""
        current_season = {
            row["league"]: row["season"]
            for row in self._rows(
                "select league, max(season) as season from fct_player_game group by league"
            )
        }
        bios = self._grouped(
            """
            select p.league, p.stats_player_id as player_id, p.espn_player_id, p.full_name,
                p.position, p.height, p.weight_lbs, p.birth_date, p.school,
                p.team_id, p.valid_from, p.valid_to, p.is_current, p.last_game_date,
                t.abbreviation as team_abbreviation, t.name as team_name
            from dim_player as p
            left join dim_team as t
                on t.league = p.league and t.team_id = p.team_id
                and t.season = (
                    select max(season) from dim_team as x
                    where x.league = p.league and x.team_id = p.team_id
                )
            order by p.league, p.stats_player_id, p.valid_from
            """
        )
        seasons = self._grouped(
            f"""
            select league, player_id, season, count(*) as games,
                cast(sum(case when played then 1 else 0 end) as bigint) as games_played,
                {", ".join(f"avg(case when played then {c} end) as {c}_pg" for c in BOX)},
                sum(field_goals_made) / nullif(sum(field_goals_attempted), 0) as field_goal_pct,
                sum(free_throws_made) / nullif(sum(free_throws_attempted), 0) as free_throw_pct,
                cast(sum(case when source_agreement = 'exact' then 1 else 0 end) as bigint)
                    as agree_exact,
                cast(sum(case when source_agreement = 'minor' then 1 else 0 end) as bigint)
                    as agree_minor,
                cast(sum(case when source_agreement = 'conflict' then 1 else 0 end) as bigint)
                    as agree_conflict,
                cast(sum(case when source_agreement = 'unverified' then 1 else 0 end) as bigint)
                    as agree_unverified
            from fct_player_game
            group by league, player_id, season
            order by league, player_id, season
            """
        )
        game_log = self._grouped(
            f"""
            select g.league, g.player_id, g.season, g.game_id, g.game_date, g.is_home,
                case when g.is_home then d.away_team_abbreviation
                    else d.home_team_abbreviation end as opponent,
                g.team_tricode, g.played, g.comment, {", ".join(f"g.{c}" for c in BOX)},
                g.plus_minus, g.source_agreement
            from fct_player_game as g
            left join dim_game as d on d.league = g.league and d.game_id = g.game_id
            order by g.league, g.player_id, g.game_date, g.game_id
            """
        )
        rolling = self._grouped(
            """
            select r.*
            from mart_player_rolling as r
            join (select league, max(season) as season from fct_player_game group by league) as cs
                on cs.league = r.league and cs.season = r.season
            order by r.league, r.player_id, r.game_date, r.game_id
            """
        )
        zscores = self._grouped(
            "select * from mart_category_zscores order by league, player_id, season, window_name"
        )
        board = self._grouped("select * from mart_board order by league, player_id")
        injuries = (
            self._grouped(
                """
                select league, stats_player_id as player_id, injury_id, status, status_group,
                    status_from, status_to, reports
                from fct_injury_status
                where stats_player_id is not null
                order by league, stats_player_id, status_from desc, injury_id
                """
            )
            if "fct_injury_status" in self._names
            else {}
        )
        shots = self._grouped(
            """
            select s.league, s.player_id, s.loc_x, s.loc_y, s.shot_made, s.is_three,
                s.shot_zone_basic, s.shot_distance
            from fct_shot as s
            join (select league, max(season) as season from fct_player_game group by league) as cs
                on cs.league = s.league and cs.season = s.season
            order by s.league, s.player_id, s.game_date, s.game_id, s.game_event_id
            """
        )
        zones = self._grouped(
            """
            select s.league, s.player_id, s.shot_zone_basic as zone,
                count(*) as attempts,
                cast(sum(case when s.shot_made then 1 else 0 end) as bigint) as made
            from fct_shot as s
            join (select league, max(season) as season from fct_player_game group by league) as cs
                on cs.league = s.league and cs.season = s.season
            group by s.league, s.player_id, s.shot_zone_basic
            order by s.league, s.player_id, s.shot_zone_basic
            """
        )
        league_zones: dict[str, dict[str, float | None]] = defaultdict(dict)
        for row in self._rows(
            """
            select s.league, s.shot_zone_basic as zone,
                sum(case when s.shot_made then 1 else 0 end) * 1.0 / count(*) as pct
            from fct_shot as s
            join (select league, max(season) as season from fct_player_game group by league) as cs
                on cs.league = s.league and cs.season = s.season
            group by s.league, s.shot_zone_basic
            """
        ):
            league_zones[row["league"]][row["zone"]] = row["pct"]

        files: dict[tuple[str, str], dict[str, Any]] = {}
        for key, stints in bios.items():
            league, player_id = key
            current = next((s for s in stints if s["is_current"]), stints[-1])
            files[key] = {
                "league": league,
                "player_id": player_id,
                "espn_player_id": current["espn_player_id"],
                "name": current["full_name"],
                "position": current["position"],
                "height": current["height"],
                "weight_lbs": current["weight_lbs"],
                "birth_date": current["birth_date"],
                "school": current["school"],
                "team": {
                    "team_id": current["team_id"],
                    "abbreviation": current["team_abbreviation"],
                    "name": current["team_name"],
                },
                "last_game_date": current["last_game_date"],
                "current_season": current_season.get(league),
                "stints": [
                    {
                        "team_id": s["team_id"],
                        "abbreviation": s["team_abbreviation"],
                        "valid_from": s["valid_from"],
                        "valid_to": s["valid_to"],
                    }
                    for s in stints
                ],
                "seasons": [
                    {k: v for k, v in s.items() if k not in ("league", "player_id")}
                    for s in seasons.get(key, [])
                ],
                "game_log": [
                    {k: v for k, v in g.items() if k not in ("league", "player_id")}
                    for g in game_log.get(key, [])
                ],
                "rolling": [
                    {
                        k: v
                        for k, v in r.items()
                        if k
                        not in ("league", "player_id", "player_game_sk", "player_sk", "team_id")
                    }
                    for r in rolling.get(key, [])
                ],
                "zscores": [
                    {k: v for k, v in z.items() if k not in ("league", "player_id", "zscore_sk")}
                    for z in zscores.get(key, [])
                ],
                "board": next(
                    (
                        {k: v for k, v in b.items() if k not in ("league", "player_id", "board_sk")}
                        for b in board.get(key, [])
                    ),
                    None,
                ),
                "injury_history": [
                    {k: v for k, v in r.items() if k not in ("league", "player_id")}
                    for r in injuries.get(key, [])
                ],
                "shots": [
                    [
                        s["loc_x"],
                        s["loc_y"],
                        1 if s["shot_made"] else 0,
                        1 if s["is_three"] else 0,
                    ]
                    for s in shots.get(key, [])
                ],
                "shot_zones": [
                    {
                        "zone": z["zone"],
                        "attempts": z["attempts"],
                        "made": z["made"],
                        "pct": (z["made"] / z["attempts"]) if z["attempts"] else None,
                        "league_pct": league_zones.get(league, {}).get(z["zone"]),
                    }
                    for z in zones.get(key, [])
                ],
            }
        return files
