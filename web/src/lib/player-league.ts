/**
 * The player page under the manager's league (#938): the player's rank and value under the
 * league's size, scoring and punts, from the same valuation every page reads (valuation.ts), and
 * which categories the league keeps. The published file's values are the default league's.
 */
import type { ModelRow } from './board-model';
import { DEFAULT_SETTINGS, isDefaultSettings, type LeagueSetup } from './fantasy-league';
import type { League } from './data';
import { leagueValues } from './valuation';

export interface PlayerLeagueValue {
  /** Where the player ranks on the board under the league's settings, by season value. */
  rank: number;
  perGame: number;
  season: number;
  rest: number;
  /** The categories the league's value counts, and those it does not (the punts; turnovers in an 8-category league). */
  activeCats: string[];
  punted: string[];
}

/** Whether the league's settings differ from the default league the published values are for. */
export const ownSettings = (league: League, setup: LeagueSetup): boolean => !isDefaultSettings(setup, DEFAULT_SETTINGS[league]);

/** The player's rank and value under the league's settings; null when the board does not hold him. */
export function playerLeagueValue<R extends ModelRow>(rows: R[], setup: LeagueSetup, playerId: string): PlayerLeagueValue | null {
  const row = rows.find((r) => r.player_id === playerId);
  if (!row) return null;
  const v = leagueValues(rows, setup);
  const season = v.seasonValue(playerId);
  const rank = rows.filter((r) => v.seasonValue(r.player_id) > season).length + 1;
  return {
    rank,
    perGame: v.perGame(playerId),
    season,
    rest: v.restValue.get(playerId) ?? 0,
    activeCats: v.activeCats,
    punted: v.punted,
  };
}
