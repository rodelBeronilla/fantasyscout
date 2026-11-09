/**
 * Whether the board's value is preseason value, which carries a badge until it is judged (ADR 0031).
 *
 * The value per game passed walk-forward against the naive manager in season: at a tenth, a quarter
 * and half way (#754). Before the first game it did not, so it is badged there every season, and
 * after the regular season, when the board projects the next one. In season the badge stays until
 * the later of a tenth of the season's games (the first in-season checkpoint judged) and, where the
 * market prior is on, its fade (ADR 0020): until then preseason information still weighs in it.
 */
import { PARAMS } from '../generated/parameters';
import type { League } from './data';

/** preseason: before the first game or after the last; early: before the judged window; in-season: validated. */
export type ValuePhase = 'preseason' | 'early' | 'in-season';

/** What the phase reads of a board row: the player's games so far, his team's games left, and whether the season is over. */
export interface SeasonRow {
  games_current?: number | null;
  games_remaining?: number | null;
  season_complete?: boolean | null;
}

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Team games into the season after which the value counts as judged in season, in this league. */
export function judgedFrom(league: League, seasonGames: number): number {
  const tenth = PARAMS['backtest.checkpoints'][1] * seasonGames;
  const prior = PARAMS['projection.market_prior'];
  const fade = (prior.leagues as readonly string[]).includes(league) ? prior.fade_games : 0;
  return Math.max(tenth, fade);
}

/**
 * The board's phase from its rows. The season's games played are the most any player has played,
 * and its length the most played plus left: a player who has played every game sets both.
 */
export function valuePhase(league: League, rows: readonly SeasonRow[]): ValuePhase {
  if (!rows.length || rows.some((r) => r.season_complete)) return 'preseason';
  const played = Math.max(...rows.map((r) => num(r.games_current)));
  if (played <= 0) return 'preseason';
  const length = Math.max(...rows.map((r) => num(r.games_current) + num(r.games_remaining)));
  return played < judgedFrom(league, length) ? 'early' : 'in-season';
}

/** Whether value shows the preseason badge: everywhere but the judged in-season window. */
export const preseasonBadge = (phase: ValuePhase): boolean => phase !== 'in-season';
