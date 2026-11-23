/**
 * The owner preview's calls of last week, graded (#1058): every entry the log holds for the week,
 * each tied to its entry by the entry's key, against what happened: the week's player data the
 * build publishes (player_week/{league}.json, the last few weeks of fct_player_week, never
 * anything about the owner's league) and the week's final totals the import brought.
 *
 * - A call that names players (an add, a drop, a swap, a stream, a trade's sides, a build row's
 *   move, a "trade, don't drop" name) shows each player's games and nine totals that week. The
 *   naive manager makes no move: he keeps the player dropped, or given.
 * - The too-close band shows how each category it called too close ended.
 * - The lineup plan's week counted starts against the games its roster played, from a plan made
 *   on the Monday (a later one counted the days left alone); a day's row is not graded, since the
 *   week's player data is by week.
 * - Anything else says why it is not graded. None is dropped, and none is counted as wrong.
 */
import type { LoggedCall } from './graded';
import { addDays, WEEK_CHANCE } from './graded';
import type { LeagueWeek } from './league-weeks';
import { soFarResult, soFarValue } from './matchup';

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

/** A player a call names, and what he is to it. */
type Role = 'add' | 'drop' | 'give' | 'get' | 'keep' | 'named';

/** What a call said and its key, then how it is graded. */
export type CallGrade = { entry: LoggedCall } & (
  | {
      kind: 'players';
      players: { id: string; role: Role; line: PlayerWeek | null }[];
      /** Players the entry left out to fit the log ("+N more"): not graded. */
      leftOut: number;
      /** The naive manager makes no move: the players he keeps in its place (the drop, or what a trade gives); none for an add alone. */
      keeps: string[];
    }
  | { kind: 'categories'; opponent: number; cats: { cat: string; result: 'win' | 'loss' | 'tie' | null }[]; leftOut: number }
  | { kind: 'lineup'; counted: number; played: number; roster: number }
  | { kind: 'not-graded'; why: string }
);

/** Last week's preview calls: every entry dated in the week of `monday`, the week's chances left out (the card grades those by category). */
export function weekCalls(calls: readonly LoggedCall[], monday: string): LoggedCall[] {
  const sunday = addDays(monday, 6); // def: Monday to Sunday
  return calls.filter((c) => c.call !== WEEK_CHANCE && c.date >= monday && c.date <= sunday);
}

const ID = '\\d{5,10}'; // def: a player id: NBA and WNBA ids are all digits
const ids = (text: string) => text.match(new RegExp(`\\b${ID}\\b`, 'g')) ?? [];
const more = (text: string) => [...text.matchAll(/\(\+(\d+) more\)/g)].reduce((n, m) => n + Number(m[1]), 0);
const side = (text: string, role: Role) => ids(text.replace(/\(\+\d+ more\)/g, '')).map((id) => ({ id, role }));

/** The players a call names, with their roles, and how many its entry left out. */
function named(c: LoggedCall): { players: { id: string; role: Role }[]; leftOut: number } | null {
  const subject = c.subject;
  const value = String(c.value);
  // "a for b": a swap, a stream, a top add with its drop
  const swap = new RegExp(`^(?<add>${ID}) for (?<drop>${ID})$`).exec(subject)?.groups;
  if (swap) return { players: [{ id: swap['add']!, role: 'add' }, { id: swap['drop']!, role: 'drop' }], leftOut: 0 };
  if (c.call === 'top-adds' && new RegExp(`^${ID}$`).test(subject)) return { players: [{ id: subject, role: 'add' }], leftOut: 0 };
  // a trade: "give > get", the finder's "team: give > get"
  const trade = /^(?:\d+: )?(?<give>.+) > (?<get>.+)$/.exec(subject)?.groups;
  if (trade && ids(trade['give']!).length + ids(trade['get']!).length > 0 && !/^(target|let go|lowest) /.test(subject))
    return { players: [...side(trade['give']!, 'give'), ...side(trade['get']!, 'get')], leftOut: more(subject) };
  // a build row: the move shown beside him first, else the player
  const row = new RegExp(`^(target|let go|lowest) (?<id>${ID})$`).exec(subject)?.groups;
  if (row) {
    const pickup = new RegExp(`^add (?<add>${ID}) drop (?<drop>${ID}) `).exec(value)?.groups;
    if (pickup) return { players: [{ id: pickup['add']!, role: 'add' }, { id: pickup['drop']!, role: 'drop' }], leftOut: 0 };
    const t = /^trade (?<give>.+?) to \d+ for (?<get>.+?) \(/.exec(value)?.groups;
    if (t) return { players: [...side(t['give']!, 'give'), ...side(t['get']!, 'get')], leftOut: more(t['give']!) + more(t['get']!) };
    return { players: [{ id: row['id']!, role: 'named' }], leftOut: 0 };
  }
  const keep = new RegExp(`^(keep|hold) (?<id>${ID})$`).exec(subject)?.groups;
  if (keep) return { players: [{ id: keep['id']!, role: 'keep' }, ...side(value, 'add')], leftOut: 0 };
  // a player alone (sell high, the nearest players)
  if (new RegExp(`^${ID}$`).test(subject)) return { players: [{ id: subject, role: 'named' }], leftOut: 0 };
  return null;
}

/** Why an entry naming no player is not graded. */
function whyNot(c: LoggedCall): string {
  const s = c.subject;
  if (s === 'held back') return 'held back by the adds limit: no move was shown';
  if (s === 'none' || s === 'no target') return 'no move was shown';
  if (s.startsWith('category ')) return "a category's standing, not a call on the week";
  if (s === 'verdict' || s === 'replace') return 'a summary of the swaps; each swap is graded on its own line';
  if (c.call === 'lineup' && s.startsWith('day ')) return "a day's plan: the week's player data is by week, not by day";
  return 'the entry does not hold enough to grade';
}

/** A slot on the injured lists: its player is not on the roster a plan counts. */
const INJURED = /^(IL|IR|NA)/i;

const EASTERN = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
/** The Eastern date of a log line's time. */
const easternDay = (at: string) => (at ? EASTERN.format(new Date(at)) : '');

/**
 * Last week's preview calls, every one graded or saying why not. `weeks` holds the published
 * player weeks (null when the build has not published that week yet); `week` the week's final
 * totals from the import (null when it does not hold them); `imports` the log's imports, for the
 * roster a lineup plan counted; `mine` the manager's team.
 */
export function gradeCalls(
  calls: readonly LoggedCall[],
  monday: string,
  weeks: readonly PlayerWeek[] | null,
  week: LeagueWeek | null,
  imports: readonly LoggedImport[],
  mine: number,
): CallGrade[] {
  const ofWeek = weeks ? new Map(weeks.filter((w) => w.week_start === monday).map((w) => [w.player_id, w])) : null;
  const published = !!ofWeek && ofWeek.size > 0;
  return weekCalls(calls, monday).map((entry): CallGrade => {
    if (entry.call === 'too-close') {
      const m = /^vs (?<opp>\d+)(?: (?<cats>.*))?$/.exec(entry.subject)?.groups;
      if (!m) return { entry, kind: 'not-graded', why: 'the entry does not name the opponent' };
      if (!week) return { entry, kind: 'not-graded', why: "the week's final totals are not imported yet" };
      const opponent = Number(m['opp']);
      const list = (m['cats'] ?? '').replace(/\(\+\d+ more\)/g, '').trim();
      const cats = list ? list.split(' ') : [];
      const a = week.teams[mine] ?? null;
      const b = week.teams[opponent] ?? null;
      return {
        entry,
        kind: 'categories',
        opponent,
        leftOut: more(m['cats'] ?? ''),
        cats: cats.map((cat) => {
          const x = soFarValue(a, cat);
          const y = soFarValue(b, cat);
          return { cat, result: x === null || y === null ? null : soFarResult(cat, x, y) };
        }),
      };
    }
    if (entry.call === 'lineup' && entry.subject === 'week') {
      const counted = /^(\d+) starts/.exec(String(entry.value));
      if (!counted) return { entry, kind: 'not-graded', why: 'the entry does not hold the starts it counted' };
      if (entry.date !== monday) return { entry, kind: 'not-graded', why: 'a plan made after the Monday counted the days left alone' };
      if (!published) return { entry, kind: 'not-graded', why: "the week's player data is not in yet" };
      // the roster the plan counted: the latest import logged by the end of the plan's day
      const imp = [...imports].reverse().find((i) => i.mine !== null && easternDay(i.at) <= entry.date);
      const roster = imp && imp.mine !== null ? (imp.rosters[imp.mine] ?? []).filter((id) => !INJURED.test(imp.slots[id] ?? '')) : [];
      if (!roster.length) return { entry, kind: 'not-graded', why: 'no import logged that day names the roster it counted' };
      const played = roster.reduce((s, id) => s + (ofWeek!.get(id)?.games_played ?? 0), 0);
      return { entry, kind: 'lineup', counted: Number(counted[1]), played, roster: roster.length };
    }
    const who = named(entry);
    if (!who || who.players.length === 0) return { entry, kind: 'not-graded', why: whyNot(entry) };
    if (!published) return { entry, kind: 'not-graded', why: "the week's player data is not in yet" };
    const keeps = who.players.filter((p) => p.role === 'drop' || p.role === 'give').map((p) => p.id);
    return { entry, kind: 'players', leftOut: who.leftOut, keeps, players: who.players.map((p) => ({ ...p, line: ofWeek!.get(p.id) ?? null })) };
  });
}
