/** The player page's data: the player file the export writes for each player, and the schedule ahead. */
import type { League } from './data';
import type { CrewFields } from './referees';
import type { ExportedRow, PlayerBoardColumn, PlayerRollingColumn, PlayerZscoreColumn } from '../generated/columns';

interface Season {
  season: string;
  games: number;
  games_played: number;
  minutes_pg: number | null;
  points_pg: number | null;
  rebounds_total_pg: number | null;
  assists_pg: number | null;
  steals_pg: number | null;
  blocks_pg: number | null;
  turnovers_pg: number | null;
  three_pointers_made_pg: number | null;
  field_goal_pct: number | null;
  free_throw_pct: number | null;
  agree_exact: number;
  agree_minor: number;
  agree_conflict: number;
  agree_unverified: number;
}

interface Game {
  season: string;
  game_id: string;
  game_date: string;
  is_home: boolean;
  opponent: string | null;
  played: boolean;
  comment: string | null;
  minutes: number | null;
  points: number | null;
  rebounds_total: number | null;
  assists: number | null;
  steals: number | null;
  blocks: number | null;
  turnovers: number | null;
  field_goals_made: number | null;
  field_goals_attempted: number | null;
  three_pointers_made: number | null;
  three_pointers_attempted: number | null;
  free_throws_made: number | null;
  free_throws_attempted: number | null;
  plus_minus: number | null;
  source_agreement: string;
}

interface ZscoreFields {
  window_name: string;
  season: string;
  games: number;
  z_total: number | null;
  [key: string]: unknown;
}
// The player file's sections name only columns the export ships (export/layout.py, #479).
export type Zscore = ExportedRow<PlayerZscoreColumn, ZscoreFields>;
type Rolling = ExportedRow<PlayerRollingColumn, { game_number: number; game_date: string; [key: string]: unknown }>;

interface PlayerBoardFields {
  rank_total: number;
  value_total: number | null;
  value_rest_of_season: number | null;
  value_per_game?: number | null;
  game_floor?: number | null;
  game_ceiling?: number | null;
  games_share?: number | null;
  availability_multiplier?: number | null;
  expected_games_missed?: number | null;
  games_remaining?: number | null;
  games_next_7?: number | null;
  season_complete?: boolean | null;
  proj_minutes_pg?: number | null;
  proj_points_pg?: number | null;
  proj_rebounds_total_pg?: number | null;
  proj_assists_pg?: number | null;
  proj_steals_pg?: number | null;
  proj_blocks_pg?: number | null;
  proj_three_pointers_made_pg?: number | null;
  proj_turnovers_pg?: number | null;
  proj_field_goal_pct?: number | null;
  proj_free_throw_pct?: number | null;
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  lineup_date?: string | null;
  market_rank?: number | null;
  ownership_bucket?: string | null;
  team_stakes?: string | null;
  rest_risk?: boolean | null;
  injury_status?: string | null;
  injury_group?: string | null;
  injury_type?: string | null;
  expected_return?: string | null;
  injury_note?: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  /** official (the league's report for the next game) or espn. */
  injury_source?: string | null;
  official_game_date?: string | null;
  news_flag?: string | null;
  news_date?: string | null;
}
type PlayerBoard = ExportedRow<PlayerBoardColumn, PlayerBoardFields>;

export interface PlayerFile {
  league: League;
  player_id: string;
  espn_player_id: string | null;
  name: string | null;
  position: string | null;
  height: string | null;
  weight_lbs: number | null;
  birth_date: string | null;
  school: string | null;
  team: { team_id: string | null; abbreviation: string | null; name: string | null };
  last_game_date: string | null;
  current_season: string | null;
  stints: { team_id: string; abbreviation: string | null; valid_from: string; valid_to: string | null }[];
  seasons: Season[];
  game_log: Game[];
  rolling: Rolling[];
  zscores: Zscore[];
  board: PlayerBoard | null;
  /** The player's signings, waivers and trades from the league's feed, newest first (NBA). */
  moves?: { transaction_date: string; team_abbreviation: string | null; move_type: string; description: string }[];
  /** ESPN's newest headlines about the player: the headline, its date and a link to ESPN (absent in older builds). */
  news?: { published_date: string; headline: string; url: string; news_flag: string | null }[];
  /** Each status the player's injury listings have held, newest first (absent in older builds). */
  injury_history?: { injury_id: string; status: string; status_group: string; status_from: string; status_to: string; reports: number }[];
  shots: [number, number, number, number][];
  shot_zones: { zone: string; attempts: number; made: number; pct: number | null; league_pct: number | null }[];
}

/** A game on the published schedule ahead (mart_schedule_upcoming). */
export interface Upcoming extends CrewFields {
  game_id: string;
  game_date: string;
  game_type: string;
  home_team_id: string;
  home_team_tricode: string;
  away_team_id: string;
  away_team_tricode: string;
  home_spread?: number | null;
  over_under?: number | null;
  home_implied_points?: number | null;
  away_implied_points?: number | null;
  line_provider?: string | null;
  line_as_of?: string | null;
  home_back_to_back?: boolean | null;
  away_back_to_back?: boolean | null;
}
