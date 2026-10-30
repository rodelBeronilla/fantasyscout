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
    TableSpec("gold.fct_injury_status", "league, stats_player_id, injury_id, status_from"),
    TableSpec("gold.fct_player_status", "league, stats_player_id", json=True),
    TableSpec("gold.fct_transaction", "league, transaction_date desc, team_id, player_id"),
    TableSpec("gold.fct_player_news", "league, stats_player_id, published_at desc, article_id"),
    TableSpec("gold.fct_team_game_context", "league, season, game_date, game_id, team_id"),
    TableSpec("gold.fct_market_value", "league, market_rank, stats_player_id"),
    TableSpec("gold.fct_waiver_trend", "league, add_rank, drop_rank, sleeper_player_id"),
    TableSpec("gold.fct_game_line", "league, season, game_date, game_id"),
    TableSpec("gold.fct_official_listing", "league, season, game_date, game_id, player_id"),
    TableSpec("gold.fct_board_history", "league, snapshot_date, rank_total, player_id"),
    TableSpec("gold.fct_team_stakes", "league, season, conference, playoff_rank", json=True),
    TableSpec("gold.mart_board", "league, rank_total, player_id"),
    TableSpec("gold.mart_player_projection", "league, player_id"),
    TableSpec("gold.mart_category_zscores", "league, window_name, season, player_id"),
    TableSpec("gold.mart_player_rolling", "league, season, player_id, game_date, game_id"),
    TableSpec("gold.mart_streamers", "league, player_id"),
    TableSpec("gold.mart_schedule_upcoming", "league, game_date, game_id"),
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
    TableSpec("ops.feed_freshness", "league, feed", json=True),
    TableSpec("ops.publish_gate", "run_at desc, run_id", json=True),
    TableSpec("ops.test_results", "run_at desc, run_id, node_id"),
    TableSpec("ops.category_config", "league, sort_order", json=True),
)

TABLES: tuple[TableSpec, ...] = GOLD + OPS

# The board, the streamers and the upcoming schedule go out per league as compact JSON the
# pages render directly: only the columns they read, numbers rounded to four decimals.
BOARD_COLUMNS = (
    "league",
    "season",
    "player_id",
    "full_name",
    "position",
    "team_id",
    "team_abbreviation",
    "games_current",
    "games_prev",
    "games_prev2",
    "w_prior",
    "minutes_current",
    "games_share",
    "in_pool",
    "rank_total",
    "value_total",
    "value_per_game",
    "value_rest_of_season",
    "ros_factor",
    "availability_multiplier",
    "expected_games_missed",
    "season_complete",
    "games_remaining",
    "games_next_7",
    "games_this_week",
    "injury_status",
    "injury_group",
    "injury_type",
    "expected_return",
    "injury_note",
    "injury_news",
    "injury_since",
    "injury_source",
    "official_game_date",
    "official_report_at",
    "news_flag",
    "news_headline",
    "news_date",
    "lineup_role",
    "lineup_confirmed",
    "lineup_date",
    "market_rank",
    "market_gap",
    "ownership_bucket",
    "ownership_trend",
    "team_stakes",
    "rest_risk",
    "z_points",
    "z_rebounds_total",
    "z_assists",
    "z_steals",
    "z_blocks",
    "z_three_pointers_made",
    "z_turnovers",
    "z_field_goal_pct",
    "z_free_throw_pct",
    "z_total",
    "recent_z_points",
    "recent_z_rebounds_total",
    "recent_z_assists",
    "recent_z_steals",
    "recent_z_blocks",
    "recent_z_three_pointers_made",
    "recent_z_turnovers",
    "recent_z_field_goal_pct",
    "recent_z_free_throw_pct",
    "recent_z_total",
    "minutes_pg",
    "points_pg",
    "rebounds_total_pg",
    "assists_pg",
    "steals_pg",
    "blocks_pg",
    "three_pointers_made_pg",
    "turnovers_pg",
    "field_goal_pct",
    "free_throw_pct",
    "proj_minutes_pg",
    "proj_points_pg",
    "proj_rebounds_total_pg",
    "proj_assists_pg",
    "proj_steals_pg",
    "proj_blocks_pg",
    "proj_three_pointers_made_pg",
    "proj_turnovers_pg",
    "proj_fgm_pg",
    "proj_fga_pg",
    "proj_ftm_pg",
    "proj_fta_pg",
    "proj_field_goal_pct",
    "proj_free_throw_pct",
    "season_z_points",
    "season_z_rebounds_total",
    "season_z_assists",
    "season_z_steals",
    "season_z_blocks",
    "season_z_three_pointers_made",
    "season_z_turnovers",
    "season_z_field_goal_pct",
    "season_z_free_throw_pct",
    "season_z_total",
    "last20_z_points",
    "last20_z_rebounds_total",
    "last20_z_assists",
    "last20_z_steals",
    "last20_z_blocks",
    "last20_z_three_pointers_made",
    "last20_z_turnovers",
    "last20_z_field_goal_pct",
    "last20_z_free_throw_pct",
    "last20_z_total",
    "age",
    "is_rookie",
    "is_new_team",
    "prev_team_abbreviation",
)
BOARD_SQL = f"""
select {", ".join(BOARD_COLUMNS)}
from gold.mart_board
order by league, rank_total, player_id
"""

STREAMER_COLUMNS = (
    "league",
    "player_id",
    "full_name",
    "position",
    "team_id",
    "team_abbreviation",
    "season",
    "season_complete",
    "games_next_7",
    "games_this_week",
    "last_game_date",
    "games_season",
    "games_in_window_5",
    "minutes_season",
    "minutes_avg_5",
    "minutes_avg_10",
    "minutes_baseline",
    "minutes_trend",
    "season_z_total",
    "value_baseline",
    "last_10_z_total",
    "value_trend",
    "last_10_production",
    "last_10_production_turnovers",
    "last_10_z_points",
    "last_10_z_rebounds_total",
    "last_10_z_assists",
    "last_10_z_steals",
    "last_10_z_blocks",
    "last_10_z_three_pointers_made",
    "last_10_z_turnovers",
    "last_10_z_field_goal_pct",
    "last_10_z_free_throw_pct",
    "board_rank",
    "board_value",
    "is_new_team",
    "prev_team_abbreviation",
    "points_avg_5",
    "rebounds_total_avg_5",
    "assists_avg_5",
    "steals_avg_5",
    "blocks_avg_5",
    "three_pointers_made_avg_5",
    "turnovers_avg_5",
    "field_goal_pct_5",
    "free_throw_pct_5",
    "injury_status",
    "injury_group",
    "injury_type",
    "expected_return",
    "injury_note",
    "injury_news",
    "injury_since",
    "injury_source",
    "official_game_date",
    "official_report_at",
    "news_flag",
    "news_headline",
    "news_date",
    "lineup_role",
    "lineup_confirmed",
    "lineup_date",
    "ownership_bucket",
    "ownership_trend",
    "team_stakes",
    "rest_risk",
    "sleeper_adds",
    "sleeper_drops",
    "waiver_trend",
)
STREAMERS_SQL = f"""
select {", ".join(STREAMER_COLUMNS)}
from gold.mart_streamers
order by league, minutes_trend desc nulls last, player_id
"""

SCHEDULE_SQL = """
select league, season, game_id, game_date, days_ahead, game_type,
    home_team_id, home_team_tricode, away_team_id, away_team_tricode, game_datetime_utc,
    home_matchup, away_matchup, home_spread, over_under, home_implied_points, away_implied_points,
    line_provider, line_as_of, home_rest_days, home_back_to_back, away_rest_days, away_back_to_back,
    away_miles_travelled, at_altitude
from gold.mart_schedule_upcoming
order by league, game_date, game_id
"""

# The latest moves per league, for Streamers' recent moves and the player pages.
# One row per line: a line naming several players (ESPN's) appears once, without a player.
TRANSACTIONS_SQL = """
select league, transaction_date, team_abbreviation, player_id, move_type, description, source
from (
    select league, transaction_date, team_abbreviation, move_type, description, source,
        case
            when count(*) over (
                partition by league, source, transaction_date, team_abbreviation, description
            ) > 1 then null
            else player_id
        end as player_id,
        row_number() over (
            partition by league, source, transaction_date, team_abbreviation, description
            order by transaction_sk
        ) as copy,
        transaction_sk
    from gold.fct_transaction
) as lines
where copy = 1
qualify row_number() over (
    partition by league order by transaction_date desc, transaction_sk
) <= 150
order by league, transaction_date desc, team_abbreviation
"""

PER_LEAGUE_JSON = (
    ("board", BOARD_SQL),
    ("streamers", STREAMERS_SQL),
    ("schedule", SCHEDULE_SQL),
    ("transactions", TRANSACTIONS_SQL),
)
JSON_DIGITS = 4

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
