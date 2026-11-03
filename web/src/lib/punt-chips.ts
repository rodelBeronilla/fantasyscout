/**
 * Trade chips and targets for a punt build (#671). A manager who punts categories ranks players
 * differently from the rest of the league: a scorer whose value is in the punted categories ranks
 * high on value but low for the build (a chip, worth more to others than to the manager), and a
 * player strong in the kept categories can rank far higher for the build than on value (a target).
 * Values over different sets of categories are on different scales, so players are compared by
 * rank: over every category the league counts, and over the kept ones alone.
 */
export interface BuildRank {
  id: string;
  /** Rank over every category the league counts: roughly where other managers see the player. */
  league: number;
  /** Rank over the manager's kept categories: where the build sees him. */
  build: number;
}

/** Each player's rank by a value, best first (1). */
export function ranks(ids: string[], value: (id: string) => number): Map<string, number> {
  return new Map([...ids].sort((a, b) => value(b) - value(a)).map((id, i) => [id, i + 1]));
}

/**
 * The manager's players the league ranks well above the build does, the biggest gap first: only
 * players a league this size rosters (`pool`) and a gap of at least `minGap` places.
 */
export function tradeChips(
  mine: string[],
  league: Map<string, number>,
  build: Map<string, number>,
  { pool, minGap, limit = 5 }: { pool: number; minGap: number; limit?: number },
): BuildRank[] {
  return mine
    .map((id) => ({ id, league: league.get(id) ?? Infinity, build: build.get(id) ?? Infinity }))
    .filter((r) => r.league <= pool && r.build - r.league >= minGap)
    .sort((a, b) => b.build - b.league - (a.build - a.league))
    .slice(0, limit);
}

/**
 * Players elsewhere the build ranks well above the league does, the biggest gap first: only
 * players who would start for the manager (ranked for the build at or above `ceiling`) and a gap
 * of at least `minGap` places.
 */
export function tradeTargets(
  others: string[],
  league: Map<string, number>,
  build: Map<string, number>,
  { ceiling, minGap, limit = 8 }: { ceiling: number; minGap: number; limit?: number },
): BuildRank[] {
  return others
    .map((id) => ({ id, league: league.get(id) ?? Infinity, build: build.get(id) ?? Infinity }))
    .filter((r) => r.build <= ceiling && r.league - r.build >= minGap)
    .sort((a, b) => b.league - b.build - (a.league - a.build))
    .slice(0, limit);
}

/** The median of the values, or 0 for none. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}
