/**
 * Who takes an out player's minutes (#820), from the lakehouse's teammate splits
 * (gold.mart_minutes_redistribution): the teammate who averaged the most more minutes in the games
 * the player missed over this season and last, and the pickup that goes with it. The top gainer is
 * the call; when someone in the league already has him, the best gainer still free is the pickup.
 * An average over past absences, not yet validated (#763).
 */

/** One row of minutes/<league>.json: a teammate's minutes with the player and without him. */
export interface MinutesRow {
  team_id: string | null;
  player_id: string;
  games_missed: number;
  teammate_id: string;
  teammate_name: string | null;
  teammate_games_without: number;
  minutes_with: number | null;
  minutes_without: number | null;
  minutes_gained: number;
  gain_rank: number;
  teammate_percent_owned: number | null;
}

export interface Gainer {
  id: string;
  name: string;
  /** Minutes a game he gained without the player. */
  gained: number;
  /** The share of ESPN leagues that roster him, when ESPN says. */
  percentOwned: number | null;
  /** The team in the manager's league that has him, by index; null when he is free. */
  owner: number | null;
  /** Games the player missed that the gain is averaged over. */
  games: number;
  with: number | null;
  without: number | null;
}

export interface MinutesCall {
  /** The teammate who gains the most minutes. */
  top: Gainer;
  /** The pickup: the top gainer when he is free, else the best gainer still free; null when none is. */
  pickup: Gainer | null;
}

/** Each player's rows, best gainer first. */
export function minutesByPlayer(rows: MinutesRow[]): Map<string, MinutesRow[]> {
  const out = new Map<string, MinutesRow[]>();
  for (const r of rows) out.set(r.player_id, [...(out.get(r.player_id) ?? []), r]);
  for (const [id, list] of out) out.set(id, [...list].sort((a, b) => a.gain_rank - b.gain_rank));
  return out;
}

/**
 * The call for one out player: null when the lakehouse has no gain for him, or he has changed
 * teams since (his rows are for a team he is no longer on).
 */
export function minutesGoTo(rows: MinutesRow[] | undefined, teamId: string | null | undefined, owner: Map<string, number>): MinutesCall | null {
  const gainers = [...(rows ?? [])]
    .sort((a, b) => a.gain_rank - b.gain_rank)
    .filter((r) => r.minutes_gained > 0 && (!teamId || !r.team_id || r.team_id === teamId))
    .map<Gainer>((r) => ({
      id: r.teammate_id,
      name: r.teammate_name ?? r.teammate_id,
      gained: r.minutes_gained,
      percentOwned: r.teammate_percent_owned,
      owner: owner.get(r.teammate_id) ?? null,
      games: r.teammate_games_without,
      with: r.minutes_with,
      without: r.minutes_without,
    }));
  const top = gainers[0];
  if (!top) return null;
  return { top, pickup: gainers.find((g) => g.owner === null) ?? null };
}

/** "+8, 41% rostered" for a free agent; "+8, on Team 4" or "+8, on your team" for one who is taken. */
export function gainerNote(g: Gainer, teamName: (t: number) => string, mine: number): string {
  const gain = `+${Math.round(g.gained)}`;
  if (g.owner === mine) return `${gain}, on your team`;
  if (g.owner !== null) return `${gain}, on ${teamName(g.owner)}`;
  return g.percentOwned === null ? gain : `${gain}, ${Math.round(g.percentOwned)}% rostered`;
}

/** The hover text: the minutes with and without, and the games behind them. */
export function gainerDetail(g: Gainer, player: string): string {
  const fmt = (m: number | null) => (m === null ? '–' : String(Math.round(m)));
  return `${g.name} averaged ${fmt(g.without)} minutes in the ${g.games} games ${player} missed and ${fmt(g.with)} in the games ${player} played, this season and last.`;
}
