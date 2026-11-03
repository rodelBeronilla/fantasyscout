/**
 * Blowout risk for a starter (#486). The game context notebook measured what a lopsided line costs
 * starters: each 5 points of absolute spread, about 0.73 minutes a game in the NBA and 0.37 in the
 * WNBA (findings of 2026-11-02; ADR 0012 keeps it out of the value). The site flags it, it does not
 * change the value: a starter whose team's next game has a spread of 10 points or more.
 */
const BLOWOUT_SPREAD = 10;
const MINUTES_PER_5_POINTS: Record<string, number> = { nba: 0.73, wnba: 0.37 };

export interface LineGame {
  game_date: string;
  days_ahead: number;
  home_team_id: string;
  away_team_id: string;
  home_spread?: number | null;
}

/** Each team's next game in the schedule: the first from today on. */
export function nextGames<G extends LineGame>(games: G[]): Map<string, G> {
  const out = new Map<string, G>();
  const ordered = games.filter((g) => g.days_ahead >= 0).sort((a, b) => a.days_ahead - b.days_ahead || a.game_date.localeCompare(b.game_date));
  for (const g of ordered) {
    if (!out.has(g.home_team_id)) out.set(g.home_team_id, g);
    if (!out.has(g.away_team_id)) out.set(g.away_team_id, g);
  }
  return out;
}

/** The spread and the minutes a starter is expected to lose, when the next game is lopsided enough. */
export function blowout(league: string, role: string | null | undefined, next: LineGame | undefined): { spread: number; minutes: number } | null {
  if (role !== 'starter' || !next || typeof next.home_spread !== 'number') return null;
  const spread = Math.abs(next.home_spread);
  if (spread < BLOWOUT_SPREAD) return null;
  const rate = MINUTES_PER_5_POINTS[league] ?? 0;
  return { spread, minutes: (spread / 5) * rate };
}
