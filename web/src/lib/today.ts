/**
 * The manager's game day (#464): of the active players (the IL left out), who plays today, who
 * plays but is listed on the injury report, and whose team has no game. "Today" is the Eastern
 * date, the day the league schedules and the 5 pm reports use, whatever the viewer's clock says.
 */
export interface TodayGame {
  game_date: string;
  game_datetime_utc?: string | null;
  home_team_id: string;
  away_team_id: string;
  home_team_tricode: string;
  away_team_tricode: string;
}

export interface TodayPlayer {
  player_id: string;
  team_id?: string | null;
  injury_group?: string | null;
}

export interface TodaySlot<P> {
  player: P;
  /** The opponent's tricode, with "v" at home and "@" away; null without a game. */
  opponent: string | null;
  home: boolean;
  /** Tip-off in UTC, when the schedule has it. */
  tipoff: string | null;
}

/** On the report and not expected to play normally: the group a manager checks before lineups lock. */
const LISTED = new Set(['out', 'doubtful', 'questionable', 'day_to_day']);

const EASTERN_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** Today's date in Eastern time, as YYYY-MM-DD. */
export function easternDate(now: Date = new Date()): string {
  return EASTERN_DATE.format(now);
}

export function todayGroups<P extends TodayPlayer>(
  players: P[],
  games: TodayGame[],
  date: string,
): { plays: TodaySlot<P>[]; listed: TodaySlot<P>[]; idle: TodaySlot<P>[]; leagueGames: number } {
  const byTeam = new Map<string, { opponent: string; home: boolean; tipoff: string | null }>();
  let leagueGames = 0;
  for (const g of games) {
    if (g.game_date !== date) continue;
    leagueGames += 1;
    const tipoff = g.game_datetime_utc ?? null;
    byTeam.set(g.home_team_id, { opponent: g.away_team_tricode, home: true, tipoff });
    byTeam.set(g.away_team_id, { opponent: g.home_team_tricode, home: false, tipoff });
  }
  const plays: TodaySlot<P>[] = [];
  const listed: TodaySlot<P>[] = [];
  const idle: TodaySlot<P>[] = [];
  for (const player of players) {
    const game = player.team_id ? byTeam.get(player.team_id) : undefined;
    if (!game) idle.push({ player, opponent: null, home: false, tipoff: null });
    else if (LISTED.has(player.injury_group ?? '')) listed.push({ player, ...game });
    else plays.push({ player, ...game });
  }
  const byTip = (a: TodaySlot<P>, b: TodaySlot<P>) => (a.tipoff ?? '').localeCompare(b.tipoff ?? '');
  plays.sort(byTip);
  listed.sort(byTip);
  return { plays, listed, idle, leagueGames };
}
