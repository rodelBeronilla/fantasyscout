/**
 * The owner preview's calls of last week, graded where the grade is plain (#1058): from the week's
 * player data the build publishes (player_week/{league}.json, the last few weeks of
 * fct_player_week), never anything about the owner's league.
 *
 * - A top add and a stream: the player's games and nine totals that week (a stream's drop beside
 *   its add). The week's totals run Monday to Sunday, including the days before the call was shown.
 * - The lineup plan: the starts the plan counted against the games its roster's players played
 *   that week, before any lineup limit; graded only from a plan made on the week's Monday, since a
 *   later one counted the days left alone.
 * - Every other call (trades, the swaps, the too-close band, building the team): not graded, no
 *   plain measure yet.
 */
import type { LoggedCall } from './graded';
import { addDays, WEEK_CHANCES } from './graded';

/** A player's fantasy week, as player_week/{league}.json publishes it (fct_player_week). */
export interface PlayerWeek {
  league: string;
  player_id: string;
  week_start: string;
  games_scheduled: number;
  games_played: number;
  points: number;
  rebounds_total: number;
  assists: number;
  steals: number;
  blocks: number;
  three_pointers_made: number;
  turnovers: number;
  field_goals_made: number;
  field_goals_attempted: number;
  free_throws_made: number;
  free_throws_attempted: number;
}

/** An import event of the owner's log: the rosters it brought, by team, and the slots as set. */
export interface LoggedImport {
  at: string;
  mine: number | null;
  rosters: string[][];
  slots: Record<string, string>;
}

/** The import events in the log's download; a line that is not one is skipped. */
export function parseImports(text: string): LoggedImport[] {
  const out: LoggedImport[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e['kind'] !== 'import' || !Array.isArray(e['rosters'])) continue;
      const rosters = (e['rosters'] as unknown[]).map((r) => (Array.isArray(r) ? r.filter((id): id is string => typeof id === 'string') : []));
      const slots = e['slots'] && typeof e['slots'] === 'object' ? (e['slots'] as Record<string, string>) : {};
      out.push({ at: typeof e['at'] === 'string' ? e['at'] : '', mine: typeof e['mine'] === 'number' ? e['mine'] : null, rosters, slots });
    } catch {
      // a line cut short: skipped
    }
  }
  return out;
}

export type CallGrade =
  | { kind: 'players'; call: 'top-adds' | 'stream'; date: string; players: { id: string; role: 'add' | 'drop'; line: PlayerWeek | null }[] }
  | { kind: 'lineup'; date: string; counted: number; played: number; roster: number }
  | { kind: 'not-graded'; call: string; date: string; why: string };

/** The calls graded in plain measures. */
const PLAIN = new Set(['top-adds', 'stream', 'lineup']);

/** The preview calls logged in the week of `monday`: each kind once, from its first showing, the week's chances left out. */
export function weekCalls(calls: readonly LoggedCall[], monday: string): LoggedCall[] {
  const sunday = addDays(monday, 6); // def: Monday to Sunday
  return calls.filter((c) => c.call !== WEEK_CHANCES && c.date >= monday && c.date <= sunday);
}

/** The players a top-adds or stream subject names: "a b c", "add for drop", or none. */
function players(c: LoggedCall): { id: string; role: 'add' | 'drop' }[] {
  if (c.subject === 'none') return [];
  if (c.call === 'stream') {
    const [add, drop] = c.subject.split(' for ');
    return [...(add ? [{ id: add, role: 'add' as const }] : []), ...(drop ? [{ id: drop, role: 'drop' as const }] : [])];
  }
  return c.subject.split(' ').filter(Boolean).map((id) => ({ id, role: 'add' as const }));
}

/** A slot on the injured lists: its player is not on the roster a plan counts. */
const INJURED = /^(IL|IR|NA)/i;

const EASTERN = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
/** The Eastern date of a log line's time. */
const easternDay = (at: string) => (at ? EASTERN.format(new Date(at)) : '');

/**
 * Last week's preview calls, graded where the grade is plain. `weeks` holds the published player
 * weeks of that week; `imports` the log's imports, for the roster a lineup plan counted.
 */
export function gradeCalls(calls: readonly LoggedCall[], monday: string, weeks: readonly PlayerWeek[], imports: readonly LoggedImport[]): CallGrade[] {
  const ofWeek = new Map(weeks.filter((w) => w.week_start === monday).map((w) => [w.player_id, w]));
  const week = weekCalls(calls, monday);
  const out: CallGrade[] = [];
  const seen = new Set<string>();
  for (const c of week) {
    if (!PLAIN.has(c.call)) {
      if (!seen.has(c.call)) out.push({ kind: 'not-graded', call: c.call, date: c.date, why: 'no plain measure yet' });
      seen.add(c.call);
      continue;
    }
    if (c.call === 'lineup') {
      if (seen.has('lineup')) continue;
      seen.add('lineup');
      const counted = /^(\d+) starts/.exec(String(c.value));
      if (c.date !== monday || !counted) {
        out.push({ kind: 'not-graded', call: 'lineup', date: c.date, why: 'the first plan of the week came after its Monday, so it counted the days left alone' });
        continue;
      }
      // the roster the plan counted: the latest import logged by the end of the plan's day
      const imp = [...imports].reverse().find((i) => i.mine !== null && easternDay(i.at) <= c.date);
      const roster = imp && imp.mine !== null ? (imp.rosters[imp.mine] ?? []).filter((id) => !INJURED.test(imp.slots[id] ?? '')) : [];
      if (!roster.length) {
        out.push({ kind: 'not-graded', call: 'lineup', date: c.date, why: 'no import logged that day names the roster it counted' });
        continue;
      }
      const played = roster.reduce((s, id) => s + (ofWeek.get(id)?.games_played ?? 0), 0);
      out.push({ kind: 'lineup', date: c.date, counted: Number(counted[1]), played, roster: roster.length });
      continue;
    }
    // a top add or a stream: one entry a kind, each player named once over the week
    const call = c.call === 'stream' ? 'stream' : 'top-adds';
    const named = players(c).filter((p) => !seen.has(`${call}:${p.role}:${p.id}`));
    if (!named.length) continue;
    for (const p of named) seen.add(`${call}:${p.role}:${p.id}`);
    let entry = out.find((g): g is Extract<CallGrade, { kind: 'players' }> => g.kind === 'players' && g.call === call);
    if (!entry) {
      entry = { kind: 'players', call, date: c.date, players: [] };
      out.push(entry);
    }
    entry.players.push(...named.map((p) => ({ ...p, line: ofWeek.get(p.id) ?? null })));
  }
  return out;
}

/** Whether the published player weeks hold the week at all: the build has published it. */
export const hasWeek = (weeks: readonly PlayerWeek[], monday: string): boolean => weeks.some((w) => w.week_start === monday);
