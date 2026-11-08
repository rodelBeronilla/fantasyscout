/**
 * Which of today's games ESPN's score so far already holds (#875). ESPN's live scoring adds a
 * player's stats as his game is played, so from tip-off the week's score so far has that game, in
 * full once it is final and up to the minute while it is under way. The rest of the week must
 * then count only what is still to play of it: nothing of a final, the minutes left of one under
 * way, all of one not started.
 *
 * The state of each game comes from ESPN's public scoreboard, read in the same sync as the league,
 * so it describes the moment the score was read and not the moment the page is looked at. When
 * the scoreboard does not answer (or for a league ESPN keeps no scoreboard of here), the
 * schedule's tip-off times stand in: a game that had tipped off by the read counts as in the score.
 */
import { easternClock } from './format';
import type { TodayGame } from './today';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';

/** Regulation: four quarters of twelve minutes. Overtime is past regulation and leaves nothing projected. */
const QUARTERS = 4; // def: an NBA game's quarters
const QUARTER_SECONDS = 12 * 60; // def: an NBA quarter, in seconds

/** The NBA tricodes ESPN abbreviates differently; every other team's is the same on both. */
const ESPN_ABBREV: Record<string, string> = { GSW: 'GS', NOP: 'NO', SAS: 'SA', UTA: 'UTAH', NYK: 'NY', WAS: 'WSH' };
export const espnAbbrev = (tricode: string): string => ESPN_ABBREV[tricode] ?? tricode;

/** Today's games as ESPN's scoreboard had them at the read (#875). */
export interface GamesRead {
  /** The Eastern date the scoreboard was read for. */
  date: string;
  /** When ESPN produced the score so far it goes with (its server's time; a cache can serve a copy minutes old). */
  scoreAt: number;
  /** For each team (ESPN's abbreviation) whose game had started: the share of it still to play, 0 once final. */
  left: Record<string, number>;
  /** Teams whose game today was postponed or cancelled: none of it is to come. */
  off: string[];
  /** Today's games on the scoreboard, and how many had started (under way or final). */
  games: number;
  started: number;
}

/** The share of a game under way still to play, from its quarter and the seconds left in it. */
export function shareLeft(period: number, clock: number): number {
  if (period > QUARTERS) return 0;
  const played = (Math.max(1, period) - 1) * QUARTER_SECONDS + (QUARTER_SECONDS - Math.min(QUARTER_SECONDS, Math.max(0, clock)));
  return Math.min(1, Math.max(0, 1 - played / (QUARTERS * QUARTER_SECONDS)));
}

interface EspnEvent {
  date?: unknown;
  status?: { period?: unknown; clock?: unknown; type?: { name?: unknown; state?: unknown; completed?: unknown } };
  competitions?: { competitors?: { team?: { abbreviation?: unknown } }[] }[];
}

const OFF = new Set(['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_SUSPENDED', 'STATUS_FORFEIT']);

/**
 * ESPN's scoreboard JSON as the share of each started game still to play when the score was
 * produced: a game set to tip after `scoreAt` is not in it yet, whatever the scoreboard says now.
 */
export function parseScoreboard(data: unknown, date: string, scoreAt: number): GamesRead {
  const events = (data as { events?: EspnEvent[] } | null)?.events;
  const left: Record<string, number> = {};
  const off: string[] = [];
  let games = 0;
  let started = 0;
  for (const e of Array.isArray(events) ? events : []) {
    const teams = (e.competitions?.[0]?.competitors ?? []).map((c) => c.team?.abbreviation).filter((a): a is string => typeof a === 'string');
    if (teams.length !== 2) continue; // def: a game has two teams
    games += 1;
    const type = e.status?.type;
    if (typeof type?.name === 'string' && OFF.has(type.name)) {
      off.push(...teams);
      continue;
    }
    const state = type?.state;
    const tip = typeof e.date === 'string' ? Date.parse(e.date) : Number.NaN;
    if ((state !== 'in' && state !== 'post') || tip > scoreAt) continue;
    started += 1;
    const period = typeof e.status?.period === 'number' ? e.status.period : 0;
    const clock = typeof e.status?.clock === 'number' ? e.status.clock : 0;
    const share = state === 'post' || type?.completed === true ? 0 : shareLeft(period, clock);
    for (const t of teams) left[t] = share;
  }
  return { date, scoreAt, left, off, games, started };
}

/** Reads today's NBA games from ESPN's public scoreboard for a score produced at `scoreAt`; null when it does not answer. */
export async function fetchGamesRead(date: string, scoreAt: number, get: typeof fetch = fetch): Promise<GamesRead | null> {
  try {
    const res = await get(`${SCOREBOARD}?dates=${date.replaceAll('-', '')}`, { headers: { accept: 'application/json' } });
    return res.ok ? parseScoreboard(await res.json(), date, scoreAt) : null;
  } catch {
    return null;
  }
}

/** Today's games as the rest of the week counts them: the share of each team's game still to play. */
export interface Tonight {
  /** Each NBA team's (the schedule's id) share of today's game still to play; a team without one is absent. */
  left: Map<string, number>;
  /** Today's games, and how many had started at the read. */
  games: number;
  started: number;
  /** True when the tip-off times stood in for ESPN's scoreboard. */
  byClock: boolean;
  /** When the score so far was produced. */
  at: number;
}

/**
 * Which of today's games the score synced at `syncedAt` holds: from ESPN's scoreboard when it was
 * read for today, else from the schedule's tip-off times.
 */
export function tonight(schedule: TodayGame[], today: string, read: GamesRead | undefined, syncedAt: number): Tonight {
  const games = schedule.filter((g) => g.game_date === today);
  const left = new Map<string, number>();
  let started = 0;
  if (read && read.date === today) {
    for (const g of games) {
      const [home, away] = [espnAbbrev(g.home_team_tricode), espnAbbrev(g.away_team_tricode)];
      const off = read.off.includes(home) || read.off.includes(away);
      const share = read.left[home] ?? read.left[away];
      if (share !== undefined) started += 1;
      left.set(g.home_team_id, off ? 0 : (share ?? 1)).set(g.away_team_id, off ? 0 : (share ?? 1));
    }
    return { left, games: games.length, started, byClock: false, at: read.scoreAt };
  }
  for (const g of games) {
    const tipped = !!g.game_datetime_utc && Date.parse(g.game_datetime_utc) <= syncedAt;
    if (tipped) started += 1;
    left.set(g.home_team_id, tipped ? 0 : 1).set(g.away_team_id, tipped ? 0 : 1);
  }
  return { left, games: games.length, started, byClock: true, at: syncedAt };
}

/** When the score so far was read, and how many of today's games it held then. */
export type ScoreRead = Pick<Tonight, 'at' | 'games' | 'started' | 'byClock'>;

/**
 * The matchup's score line, e.g. "Score so far from ESPN at 20:15 ET, with 5 of today's 7 games
 * started: ...". A Yahoo score comes with no scoreboard read (#874), so its games go by the
 * tip-off times.
 */
export function readLine(read: ScoreRead, host: 'espn' | 'yahoo' = 'espn'): string {
  const at = `Score so far from ${host === 'yahoo' ? 'Yahoo' : 'ESPN'} at ${easternClock(new Date(read.at).toISOString())} ET`;
  const why = host === 'yahoo' ? 'Yahoo sends no game states' : "ESPN's scoreboard did not answer";
  const how = read.byClock ? ` (by the tip-off times: ${why})` : '';
  if (read.games === 0) return `${at}; no games today.`;
  if (read.started === 0) return `${at}, before today's ${read.games === 1 ? 'game' : `${read.games} games`}${how}: the games left count all of today.`;
  const of = read.started === read.games ? `all ${read.games} of today's games` : `${read.started} of today's ${read.games} games`;
  return `${at}, with ${of} started${how}: the score holds what they have played, so the games left count only the rest.`;
}
