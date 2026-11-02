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

from export import layout
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

# The newest ESPN headlines kept per player: the page links to ESPN for anything older.
NEWS_PER_PLAYER = 8


Key = tuple[str, str]
Rows = dict[Key, list[dict[str, Any]]]

# The current season of each league: the newest one with a box score.
_CURRENT = "(select league, max(season) as season from fct_player_game group by league)"


def _without_key(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in ("league", "player_id")}


class PlayerFiles:
    """Builds every player's file from the gold tables of one build.

    Each section of the file is one query (#483): ``bios``, ``seasons``, ``game_log``,
    ``rolling``, ``zscores``, ``board``, ``injuries``, ``moves``, ``news``, ``shots`` and
    ``zones`` return rows grouped by (league, player_id), and ``assemble`` puts one player's
    file together from them.
    """

    def __init__(self, tables: dict[str, pa.Table]) -> None:
        self._con = duckdb.connect()
        self._names = set(tables)
        for name, table in tables.items():
            self._con.register(name, table)

    def close(self) -> None:
        self._con.close()

    def _rows(self, sql: str) -> list[dict[str, Any]]:
        return rows_of(self._con.sql(sql).to_arrow_table())

    def _grouped(self, sql: str, key: str = "player_id") -> Rows:
        groups: Rows = defaultdict(list)
        for row in self._rows(sql):
            groups[(row["league"], str(row[key]))].append(row)
        return groups

    def _optional(self, table: str, sql: str) -> Rows:
        """A section from a table an older build may not have: empty without it."""
        return self._grouped(sql) if table in self._names else {}

    def current_seasons(self) -> dict[str, str]:
        return {row["league"]: row["season"] for row in self._rows(f"select * from {_CURRENT}")}

    def bios(self) -> Rows:
        """Every stint of every player in dim_player, oldest first, with the team's name."""
        return self._grouped(
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

    def seasons(self) -> Rows:
        """A line per season: games, per-game averages over games played, shooting, agreement."""
        return self._grouped(
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

    def game_log(self) -> Rows:
        """Every game, oldest first, with the opponent from dim_game."""
        return self._grouped(
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

    def rolling(self) -> Rows:
        """The current season's rolling averages, the layout's columns, game by game."""
        rolling_cols = ", ".join(f"r.{c}" for c in layout.PLAYER_ROLLING_COLUMNS)
        return self._grouped(
            f"""
            select r.league, r.player_id, {rolling_cols}
            from mart_player_rolling as r
            join {_CURRENT} as cs
                on cs.league = r.league and cs.season = r.season
            order by r.league, r.player_id, r.game_date, r.game_id
            """
        )

    def zscores(self) -> Rows:
        return self._grouped(
            f"""
            select league, player_id, {", ".join(layout.PLAYER_ZSCORE_COLUMNS)}
            from mart_category_zscores order by league, player_id, season, window_name
            """
        )

    def board(self) -> Rows:
        return self._grouped(
            f"""
            select league, player_id, {", ".join(layout.PLAYER_BOARD_COLUMNS)}
            from mart_board order by league, player_id
            """
        )

    def injuries(self) -> Rows:
        return self._optional(
            "fct_injury_status",
            """
            select league, stats_player_id as player_id, injury_id, status, status_group,
                status_from, status_to, reports
            from fct_injury_status
            where stats_player_id is not null
            order by league, stats_player_id, status_from desc, injury_id
            """,
        )

    def moves(self) -> Rows:
        return self._optional(
            "fct_transaction",
            """
            select league, player_id, transaction_date, team_abbreviation, move_type,
                description
            from fct_transaction
            where player_id is not null
            order by league, player_id, transaction_date desc
            """,
        )

    def news(self) -> Rows:
        """The newest NEWS_PER_PLAYER headlines per player."""
        return self._optional(
            "fct_player_news",
            f"""
            select league, player_id, published_date, headline, url, news_flag
            from (
                select league, stats_player_id as player_id, published_date, published_at,
                    headline, url, news_flag,
                    row_number() over (
                        partition by league, stats_player_id
                        order by published_at desc, article_id
                    ) as rn
                from fct_player_news
            ) as n
            where rn <= {NEWS_PER_PLAYER}
            order by league, player_id, published_at desc
            """,
        )

    def shots(self) -> Rows:
        """The current season's shots, in the order they were taken."""
        return self._grouped(
            f"""
            select s.league, s.player_id, s.loc_x, s.loc_y, s.shot_made, s.is_three,
                s.shot_zone_basic, s.shot_distance
            from fct_shot as s
            join {_CURRENT} as cs
                on cs.league = s.league and cs.season = s.season
            order by s.league, s.player_id, s.game_date, s.game_id, s.game_event_id
            """
        )

    def zones(self) -> Rows:
        """The current season's attempts and makes per zone, per player."""
        return self._grouped(
            f"""
            select s.league, s.player_id, s.shot_zone_basic as zone,
                count(*) as attempts,
                cast(sum(case when s.shot_made then 1 else 0 end) as bigint) as made
            from fct_shot as s
            join {_CURRENT} as cs
                on cs.league = s.league and cs.season = s.season
            group by s.league, s.player_id, s.shot_zone_basic
            order by s.league, s.player_id, s.shot_zone_basic
            """
        )

    def league_zones(self) -> dict[str, dict[str, float | None]]:
        """The league's make rate per zone this season, to set a player's against."""
        out: dict[str, dict[str, float | None]] = defaultdict(dict)
        for row in self._rows(
            f"""
            select s.league, s.shot_zone_basic as zone,
                sum(case when s.shot_made then 1 else 0 end) * 1.0 / count(*) as pct
            from fct_shot as s
            join {_CURRENT} as cs
                on cs.league = s.league and cs.season = s.season
            group by s.league, s.shot_zone_basic
            """
        ):
            out[row["league"]][row["zone"]] = row["pct"]
        return out

    def build(self) -> dict[Key, dict[str, Any]]:
        """{(league, player_id): file} for every player in dim_player."""
        sections = {
            "seasons": self.seasons(),
            "game_log": self.game_log(),
            "rolling": self.rolling(),
            "zscores": self.zscores(),
            "board": self.board(),
            "moves": self.moves(),
            "news": self.news(),
            "injury_history": self.injuries(),
            "shots": self.shots(),
            "shot_zones": self.zones(),
        }
        seasons, league_zones = self.current_seasons(), self.league_zones()
        return {
            key: assemble(key, stints, sections, seasons.get(key[0]), league_zones.get(key[0], {}))
            for key, stints in self.bios().items()
        }


def assemble(
    key: Key,
    stints: list[dict[str, Any]],
    sections: dict[str, Rows],
    current_season: str | None,
    league_zones: dict[str, float | None],
) -> dict[str, Any]:
    """One player's file from their stints and the rows each section holds for them."""
    league, player_id = key
    current = next((s for s in stints if s["is_current"]), stints[-1])

    def rows(section: str) -> list[dict[str, Any]]:
        return [_without_key(r) for r in sections[section].get(key, [])]

    board = rows("board")
    return {
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
        "current_season": current_season,
        "stints": [
            {
                "team_id": s["team_id"],
                "abbreviation": s["team_abbreviation"],
                "valid_from": s["valid_from"],
                "valid_to": s["valid_to"],
            }
            for s in stints
        ],
        "seasons": rows("seasons"),
        "game_log": rows("game_log"),
        "rolling": rows("rolling"),
        "zscores": rows("zscores"),
        "board": board[0] if board else None,
        "moves": rows("moves"),
        "news": rows("news"),
        "injury_history": rows("injury_history"),
        "shots": [
            [s["loc_x"], s["loc_y"], 1 if s["shot_made"] else 0, 1 if s["is_three"] else 0]
            for s in sections["shots"].get(key, [])
        ],
        "shot_zones": [
            {
                "zone": z["zone"],
                "attempts": z["attempts"],
                "made": z["made"],
                "pct": (z["made"] / z["attempts"]) if z["attempts"] else None,
                "league_pct": league_zones.get(z["zone"]),
            }
            for z in sections["shot_zones"].get(key, [])
        ],
    }
