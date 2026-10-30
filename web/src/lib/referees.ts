/** A game's referee crew, once the leagues post the day's assignments (mart_schedule_upcoming). */
export interface CrewFields {
  crew_chief?: string | null;
  /** The games behind the tendency: each official's, this season and last, added up. */
  crew_games?: number | null;
  /** Per game, both teams, against the league's average game; shrunk toward zero for a short history. */
  crew_fouls_delta?: number | null;
  crew_fta_delta?: number | null;
  crew_pace_delta?: number | null;
}

function signed(x: number): string {
  const r = Math.round(x * 10) / 10;
  return `${r > 0 ? '+' : ''}${r.toFixed(1)}`;
}

/**
 * "Crew chief Tony Brothers (fouls +1.4, FTA +2.1, pace -0.6 a game vs average)", or just the
 * crew chief while the crew has no history; null before the assignments are posted. Context
 * only: the tendency is not in the matchup value.
 */
export function crewText(g: CrewFields): string | null {
  if (!g.crew_chief) return null;
  const parts = [
    typeof g.crew_fouls_delta === 'number' ? `fouls ${signed(g.crew_fouls_delta)}` : null,
    typeof g.crew_fta_delta === 'number' ? `FTA ${signed(g.crew_fta_delta)}` : null,
    typeof g.crew_pace_delta === 'number' ? `pace ${signed(g.crew_pace_delta)}` : null,
  ].filter(Boolean);
  return parts.length ? `Crew chief ${g.crew_chief} (${parts.join(', ')} a game vs average)` : `Crew chief ${g.crew_chief}`;
}
