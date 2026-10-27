"""What a build contains (SPEC.md, "Export step").

Every gold model goes out as Parquet (zstd); the small ones also as JSON; the four big facts are
split per league-season so a page or the SQL console can range-read one season. The ops tables
that Data Health shows go out as JSON. Per-player files are assembled separately (players.py).

Everything a build publishes lives under ``builds/<build_id>/``; ``latest.json`` at the root
points at the current build and ``builds.json`` lists the builds kept for rollback.
"""

from __future__ import annotations

from dataclasses import dataclass, field

KEEP_BUILDS = 7
LEAGUES = ("wnba", "nba")


@dataclass(frozen=True)
class TableSpec:
    table: str  # schema.table in the warehouse
    order_by: str
    json: bool = False  # also write <name>.json (small tables only)
    partition: bool = False  # one Parquet per league-season instead of one file
    where: str | None = None  # ops tables: keep the export small
    extra_columns: tuple[str, ...] = field(default_factory=tuple)

    @property
    def name(self) -> str:
        return self.table.split(".", 1)[1]

    @property
    def sql(self) -> str:
        where = f" where {self.where}" if self.where else ""
        return f"select * from {self.table}{where} order by {self.order_by}"


GOLD: tuple[TableSpec, ...] = (
    TableSpec("gold.dim_date", "date_day"),
    TableSpec("gold.dim_team", "league, season, team_id", json=True),
    TableSpec("gold.dim_game", "league, season, game_date, game_id", json=True),
    TableSpec("gold.dim_player", "league, stats_player_id, valid_from", json=True),
    TableSpec("gold.fct_availability", "league, report_date, injury_id", json=True),
    TableSpec("gold.mart_board", "league, rank_total, player_id"),
    TableSpec("gold.mart_category_zscores", "league, window_name, season, player_id", json=True),
    TableSpec("gold.mart_player_rolling", "league, season, player_id, game_date, game_id"),
    TableSpec("gold.mart_streamers", "league, player_id"),
    TableSpec(
        "gold.fct_player_game", "league, season, game_date, game_id, player_id", partition=True
    ),
    TableSpec("gold.fct_team_game", "league, season, game_date, game_id, team_id", partition=True),
    TableSpec(
        "gold.fct_event", "league, season, game_date, game_id, action_number", partition=True
    ),
    TableSpec("gold.fct_shot", "league, season, game_date, game_id, game_event_id", partition=True),
)

OPS: tuple[TableSpec, ...] = (
    TableSpec("ops.reconciliation_summary", "league, season", json=True),
    TableSpec("ops.reconciliation", "league, season, game_id, stats_player_id, stat"),
    TableSpec("ops.ingest_log", "started_at desc, run_id", json=True),
    TableSpec("ops.publish_gate", "run_at desc, run_id", json=True),
    TableSpec("ops.test_results", "run_at desc, run_id, node_id"),
    TableSpec("ops.category_config", "league, sort_order", json=True),
)

TABLES: tuple[TableSpec, ...] = GOLD + OPS

# The board and the streamers go out per league with the player's name and team attached,
# which is what the pages render; the Parquet keeps the bare mart.
BOARD_SQL = """
select
    b.*,
    p.full_name,
    p.position
from gold.mart_board as b
left join gold.dim_player as p
    on p.league = b.league and p.stats_player_id = b.player_id and p.is_current
order by b.league, b.rank_total, b.player_id
"""

STREAMERS_SQL = """
select
    s.*,
    p.full_name,
    p.position
from gold.mart_streamers as s
left join gold.dim_player as p
    on p.league = s.league and p.stats_player_id = s.player_id and p.is_current
order by s.league, s.minutes_trend desc nulls last, s.player_id
"""

# The latest build's checks, one row per check, for Data Health.
LATEST_CHECKS_SQL = """
select check_name, model, severity, status, failures, execution_time, run_id, run_at
from ops.test_results
where run_id = (select run_id from ops.publish_gate order by run_at desc limit 1)
    and resource_type = 'test'
order by severity, status, check_name
"""

DATA_AS_OF_SQL = """
select league, cast(max(game_date) as string) as data_as_of
from gold.fct_player_game
where played
group by league
order by league
"""

ROW_COUNTS_SQL = "select '{table}' as name, count(*) as rows from {table}"


def partition_key(league: str, season: str) -> str:
    return f"{league}-{season}"
