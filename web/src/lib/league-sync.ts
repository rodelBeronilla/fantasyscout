/**
 * Keeping an imported league current (#815). An ESPN public league is read again from ESPN's API
 * when the manager opens a page that uses it, at most once every quarter hour: rosters, teams,
 * settings and this week's opponent from ESPN's schedule. A copy the manager has edited by hand
 * since the import is never replaced without asking. A Yahoo league comes in through the
 * bookmarklet, which only the manager can run, so its copy says how old it is instead.
 */
import { espnLeagueUrl, fromEspnLeague, type ImportedLeague } from './espn-league';
import { DEFAULT_SETTINGS, type LeagueSetup, type LeagueSource, matchNames, normalize } from './fantasy-league';
import type { ScoreSoFar } from './matchup';

/** How long an ESPN re-import stands before a visit reads the league again. */
export const SYNC_EVERY_MS = 15 * 60 * 1000; // def: a quarter hour, in ms
/** How old a Yahoo copy gets before the page offers to re-sync it. */
export const YAHOO_STALE_MS = 24 * 60 * 60 * 1000; // def: a day, in ms

const MINUTE = 60 * 1000; // def: ms in a minute
const HOUR = 60 * MINUTE; // def: minutes in an hour
const DAY = 24 * HOUR; // def: hours in a day

type Players = { player_id: string; full_name: string | null }[];

/** Reads a public ESPN league; the error says what to do about a private or missing one. */
export async function fetchEspnLeague(leagueId: string, season: string, get: typeof fetch = fetch): Promise<ImportedLeague> {
  const res = await get(espnLeagueUrl(leagueId, season), { headers: { accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'ESPN keeps this league private. Its manager can make it viewable to the public in the league settings (Basic Settings, Make League Viewable to Public), then import again.',
    );
  }
  if (res.status === 404) throw new Error(`ESPN has no ${season} league with ID ${leagueId}.`);
  if (!res.ok) throw new Error(`ESPN answered ${res.status}; try again in a moment.`);
  return fromEspnLeague(await res.json());
}

/** Each team's roster keyed by ESPN's team id where there is one, else by its place in the league. */
function keyed(rosters: string[][], ids: (number | null)[] | undefined): Map<string, Set<string>> {
  return new Map(rosters.map((r, i) => [typeof ids?.[i] === 'number' ? `id:${ids[i]}` : `#${i}`, new Set(r)]));
}

/**
 * The roster moves between two copies of a league: every player a team added plus every player it
 * dropped. A trade of one player for one counts four, two on each side.
 */
export function rosterChanges(before: string[][], after: string[][], beforeIds?: (number | null)[], afterIds?: (number | null)[]): number {
  const was = keyed(before, beforeIds);
  const now = keyed(after, afterIds);
  let n = 0;
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(key) ?? new Set<string>();
    const b = now.get(key) ?? new Set<string>();
    for (const id of b) if (!a.has(id)) n += 1;
    for (const id of a) if (!b.has(id)) n += 1;
  }
  return n;
}

/** Whether the manager has changed the rosters by hand since the league was imported. */
export function hasManualEdits(setup: LeagueSetup): boolean {
  const source = setup.source;
  if (!source) return false;
  if (source.rosters.length !== setup.rosters.length) return true;
  return rosterChanges(source.rosters, setup.rosters) > 0;
}

/** What a visit should do about an ESPN league: nothing, re-import it, or ask first. */
export function syncDue(setup: LeagueSetup, now: number): 'none' | 'fresh' | 'edited' | 'due' {
  const source = setup.source;
  if (source?.host !== 'espn') return 'none';
  if (hasManualEdits(setup)) return 'edited';
  return now - source.syncedAt < SYNC_EVERY_MS ? 'fresh' : 'due';
}

export interface EspnSync {
  setup: LeagueSetup;
  name: string;
  matched: number;
  total: number;
  unmatched: string[];
  /** The roster adds and drops against the copy it replaced; null on a first import. */
  changes: number | null;
}

/**
 * The league from an ESPN import. A first import (no previous copy) starts fresh; a re-import keeps
 * the manager's own choices (their team, matched by ESPN's team id, the punts and the injured list)
 * and takes everything else from ESPN, this week's opponent included when the schedule has one.
 */
export function espnSetup(league: ImportedLeague, players: Players, at: { leagueId: string; season: string; now: number }, previous: LeagueSetup | null): EspnSync {
  const base = DEFAULT_SETTINGS.nba;
  const unmatched: string[] = [];
  let matched = 0;
  const rosters = league.teams.map((t) => {
    const found = matchNames(t.players.join('\n'), players);
    matched += found.matched.length;
    unmatched.push(...found.unmatched);
    return found.matched;
  });
  const teamIds = league.teams.map((t) => t.id);
  const prevIds = previous?.source?.host === 'espn' ? previous.source.teamIds : undefined;
  const mineId = prevIds?.[previous?.mine ?? 0];
  const mineAt = typeof mineId === 'number' ? teamIds.indexOf(mineId) : -1;
  const mine = mineAt >= 0 ? mineAt : (previous?.mine ?? 0);
  const opponents = teamIds.map((id) => {
    const them = id === null ? undefined : league.opponents.get(id);
    const at = them === undefined ? -1 : teamIds.indexOf(them);
    return at >= 0 ? at : null;
  });
  const setup = normalize(
    {
      ...(previous ? { punts: previous.punts, il: previous.il } : {}),
      teams: league.teams.length || league.settings.teams,
      rosterSpots: league.settings.rosterSpots || base.rosterSpots,
      scoring: league.settings.scoring,
      format: league.settings.format,
      weights: league.settings.weights ? { ...base.weights, ...league.settings.weights } : base.weights,
      lineup: league.settings.lineup,
      names: league.teams.map((t) => t.name),
      rosters,
      mine,
      // with a schedule, ESPN says who the manager faces (nobody on a bye); without one, the choice stands
      opponent: league.opponents.size > 0 ? opponents[mine] : (previous?.opponent ?? null),
      drafting: false,
      picks: [],
    },
    base,
  );
  const changes = previous ? rosterChanges(previous.rosters, setup.rosters, prevIds, teamIds) : null;
  const source: LeagueSource = {
    host: 'espn',
    leagueId: at.leagueId,
    season: at.season,
    syncedAt: at.now,
    rosters: setup.rosters,
    teamIds,
    changes,
    opponents,
    // this week's score so far in a category league, for the matchup to start from (#817)
    ...(league.scores.size > 0 ? { scores: teamIds.map((id) => (id === null ? null : (league.scores.get(id) ?? null))) } : {}),
    // each team's record and place so far, for the standings at the top of My Team (#822)
    ...(league.teams.some((t) => t.record) ? { records: league.teams.map((t) => t.record) } : {}),
  };
  return {
    setup: { ...setup, source },
    name: league.name,
    matched,
    total: league.teams.reduce((s, t) => s + t.players.length, 0),
    unmatched,
    changes,
  };
}

/**
 * The score so far for the week's matchup between the manager and the opponent (#817), when the
 * league came from ESPN with one and it was read today: an older score misses the days since, so
 * the week projects from the games left instead. The reason says which.
 */
export function weekScore(
  setup: LeagueSetup,
  today: string,
  dateOf: (ms: number) => string,
): { mine: ScoreSoFar; theirs: ScoreSoFar } | 'not-espn' | 'no-score' | 'stale' {
  const source = setup.source;
  if (source?.host !== 'espn') return 'not-espn';
  const mine = source.scores?.[setup.mine];
  const theirs = setup.opponent === null ? null : source.scores?.[setup.opponent];
  if (!mine || !theirs) return 'no-score';
  return dateOf(source.syncedAt) === today ? { mine, theirs } : 'stale';
}

/** The league after the manager picks their team: this week's opponent follows from ESPN's schedule when it is known. */
export function chooseMine(setup: LeagueSetup, mine: number): LeagueSetup {
  const scheduled = setup.source?.opponents?.[mine];
  return { ...setup, mine, opponent: typeof scheduled === 'number' ? scheduled : setup.opponent };
}

/** A Yahoo bookmarklet import's record: when it ran and the rosters it brought. */
export function yahooSource(leagueId: string, rosters: string[][], now: number): LeagueSource {
  return { host: 'yahoo', leagueId, syncedAt: now, rosters, changes: null };
}

/** How long ago a time was, in words: "just now", "4 min ago", "3 hours ago", "2 days ago". */
export function ago(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  const d = Math.floor(ms / DAY);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** The line that leads My Team about an ESPN copy, e.g. "Synced 4 min ago · 2 roster changes since your last visit". */
export function espnSyncLine(source: LeagueSource, now: number): string {
  const synced = `Synced ${ago(source.syncedAt, now)}`;
  if (source.changes === null) return synced;
  const n = source.changes;
  return `${synced} · ${n === 0 ? 'no' : n} roster ${n === 1 ? 'change' : 'changes'} since your last visit`;
}

/** Whether a Yahoo copy is old enough to offer a re-sync. */
export function yahooStale(source: LeagueSource, now: number): boolean {
  return now - source.syncedAt >= YAHOO_STALE_MS;
}
