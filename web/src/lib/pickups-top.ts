/**
 * Pickups' top adds (#819): the best few free agents for the window by the page's own ranking
 * (window value, or the fit in the categories picked as needs; only players with a game on the
 * open days when days are picked), each with the reasons in one line and the player to drop from
 * the roster review. Pure, so the page and the tests share it.
 */
import { keepsPositions } from './players';

/** A Pickups candidate as the selection reads it; the last-ten category z-scores by name. */
export interface AddRow {
  player_id: string;
  position: string | null;
  injury_group: string | null;
  games_window: number;
  games_picked: number;
  window_value: number | null;
  fit: number | null;
  minutes_trend: number | null;
  top_teammate_out?: string | null;
  [key: string]: unknown;
}

export interface TopAddsInput<R extends AddRow> {
  rows: R[];
  /** Whether a player can be added: on no roster in the league, or outside the likely-rostered cut. */
  available: (row: R) => boolean;
  /** The categories picked as needs: the ranking follows the fit in them, as the table's does. */
  needs: readonly string[];
  /** The categories the league counts, its punts left out. */
  kept: readonly string[];
  /** How many open days are picked inside the window. */
  openDays: number;
  /** The manager's players who may be dropped, in the roster review's order (empty without rosters). */
  drops: readonly string[];
  /** The manager's active roster, for the position check. */
  roster: readonly string[];
  position: (id: string) => string | null | undefined;
  limit?: number;
}

export interface TopAdd<R extends AddRow> {
  row: R;
  /** Team games in the window, and on the picked open days (null with none picked). */
  games: number;
  openGames: number | null;
  minutesTrend: number | null;
  /** The team's top-usage player listed out for the next game. */
  teammateOut: string | null;
  /** The kept categories his last ten games help most: the needs first, then the largest. */
  helps: string[];
  /** Who to drop for him: the first in the review's order whose loss leaves every position covered; null when none does. */
  drop: string | null;
}

/** Categories named per add. */
const HELPS = 2; // display: categories in the reason line
const TOP = 3; // display: adds listed
/** A change in minutes a game smaller than this is left out of the reasons. */
const MINUTES_SHOWN = 1; // display: a smaller swing in the last five games is noise in a one-line reason

/** Ruled out or doubtful: not an add for the window. */
const UNAVAILABLE = new Set(['out', 'doubtful']);

/** The ranking value: the fit in the needs when any are picked, else the window value. */
export function rankValue(row: AddRow, needs: readonly string[]): number | null {
  return needs.length ? row.fit : row.window_value;
}

/** The kept categories a player's last ten games add to, the needs first, then by size. */
export function helpedCategories(row: AddRow, kept: readonly string[], needs: readonly string[]): string[] {
  const z = (c: string) => {
    const v = row[`last_10_${c}`];
    return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
  };
  return kept
    .filter((c) => z(c) > 0)
    .sort((a, b) => Number(needs.includes(b)) - Number(needs.includes(a)) || z(b) - z(a))
    .slice(0, HELPS);
}

/** The first droppable player whose place the add can take with every position still covered. */
export function dropFor(add: string, drops: readonly string[], roster: readonly string[], position: (id: string) => string | null | undefined): string | null {
  return drops.find((d) => keepsPositions(roster, [...roster.filter((id) => id !== d), add], position)) ?? null;
}

export function topAdds<R extends AddRow>(input: TopAddsInput<R>): TopAdd<R>[] {
  const { openDays } = input;
  // a build without the last-ten category columns has no fit: the window value ranks instead
  const needs = input.rows.some((r) => typeof r.fit === 'number') ? input.needs : [];
  const ranked = input.rows
    .filter((r) => input.available(r))
    .filter((r) => !UNAVAILABLE.has(r.injury_group ?? ''))
    .filter((r) => r.games_window > 0 && (openDays === 0 || r.games_picked > 0))
    .filter((r) => typeof rankValue(r, needs) === 'number')
    .sort((a, b) => (rankValue(b, needs) ?? 0) - (rankValue(a, needs) ?? 0))
    .slice(0, input.limit ?? TOP);
  return ranked.map((row) => ({
    row,
    games: row.games_window,
    openGames: openDays > 0 ? row.games_picked : null,
    minutesTrend: row.minutes_trend !== null && Math.abs(row.minutes_trend) >= MINUTES_SHOWN ? row.minutes_trend : null,
    teammateOut: row.top_teammate_out ?? null,
    helps: helpedCategories(row, input.kept, input.needs),
    drop: input.drops.length ? dropFor(row.player_id, input.drops, input.roster, input.position) : null,
  }));
}
