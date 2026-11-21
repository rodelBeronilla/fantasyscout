/**
 * Last week, graded (#1058): for the owner, each category's chance at the week's start against
 * what happened, and a running record over the graded weeks.
 *
 * - The chance is My Team's matchup card's (validated, ADR 0026), recorded once a fantasy week in
 *   the owner's private log (owner-log.ts) as a `week-chances` call: the first time My Team shows
 *   the matchup that week. A record made after the Monday is a mid-week one, with the score so far
 *   at that moment, and the card says so.
 * - What happened is the week's final totals as Yahoo scored them (the import's weeks, #1049),
 *   compared category by category as the matchup card compares a score so far (soFarResult).
 * - A call is the side a chance favours. A 50% chance, or a category tied, is no call. The Brier
 *   score is the mean of (chance − result)², 1 for a category won and 0 for one lost, over the
 *   categories won or lost; a coin's 50% scores 0.25 on every one.
 */
import type { League } from './data';
import { mondayOf, type LeagueSource } from './fantasy-league';
import { CATEGORY_LABELS } from './format';
import type { LeagueWeek } from './league-weeks';
import { type ScoreSoFar, soFarResult, soFarValue } from './matchup';

/** The day the owner's log shipped (#1033 merged): grading starts with the first full fantasy week after it. */
const LOG_SHIPPED = '2026-11-17'; // def: the owner's log shipped (#1033), 2026-11-17

/** The call the week's chances are logged under. */
export const WEEK_CHANCES = 'week-chances';

/** A coin's chance, and its Brier score on any category won or lost. */
const COIN = 1 / 2; // def: a coin flip
export const COIN_BRIER = COIN * COIN; // def: (0.5 − 0 or 1)², whatever happens

const DAY_MS = 86_400_000; // def: a day in ms
const WEEK_DAYS = 7; // def: a fantasy week, Monday to Sunday

/** The date `days` after an ISO date. */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10); // def: YYYY-MM-DD
}

/** The first week graded (its Monday: the first Monday on or after the log shipped) and the day its grade first shows (the Monday after). */
export function gradingStarts(shipped: string = LOG_SHIPPED): { week: string; firstGrade: string } {
  const monday = mondayOf(shipped);
  const week = monday === shipped ? monday : addDays(monday, WEEK_DAYS);
  return { week, firstGrade: addDays(week, WEEK_DAYS) };
}

/** A week's chances as the log holds them. */
export interface WeekChances {
  league: League;
  /** The week's Monday. */
  monday: string;
  /** The opponent's team index in the league setup. */
  opponent: number;
  /** The Yahoo week number, when an import placed the week; null when none did. */
  week: number | null;
  /** The manager's chance of winning each category, by category key (z_points...). */
  chances: Record<string, number>;
  /** The score so far when it was recorded, in categories won, lost and tied; null without one. */
  soFar: [number, number, number] | null;
  /** The Eastern date it was recorded: after the Monday, a mid-week record. */
  date: string;
  /** When the log took it, ISO; '' when the line had no time. */
  at: string;
}

const LABEL_TO_CAT = new Map(Object.entries(CATEGORY_LABELS).map(([cat, label]) => [label, cat]));
const MAX_VALUE = 200; // def: the longest value the Worker's log takes (worker/src/owner-log.ts)

/** A chance as the log keeps it: to a thousandth. */
const keep = (p: number, digits: number) => Number(p.toFixed(digits));

/**
 * The call logged for the week (a call the matchup card already shows; this only records it):
 * the subject is the league, the week's Monday and the opponent's index; the value a compact JSON
 * of each category's chance by its label, the Yahoo week and the score so far; the naive answer
 * a coin's 50%.
 */
export function weekChancesCall(c: Omit<WeekChances, 'date' | 'at'>): { call: string; subject: string; value: string; naive: number } {
  const encode = (digits: number) =>
    JSON.stringify({
      w: c.week,
      c: Object.fromEntries(Object.entries(c.chances).map(([cat, p]) => [CATEGORY_LABELS[cat] ?? cat, keep(p, digits)])),
      s: c.soFar,
    });
  const fine = encode(3); // def: a chance to a thousandth
  return { call: WEEK_CHANCES, subject: `${c.league}:${c.monday}:${c.opponent}`, value: fine.length <= MAX_VALUE ? fine : encode(2), naive: COIN }; // def: to a hundredth when a thousandth is too long
}

/** A call event of the owner's log, as its download holds it. */
export interface LoggedCall {
  at: string;
  date: string;
  call: string;
  subject: string;
  value: number | string;
  naive: number | string | null;
  build: string;
}

/** The call events in the log's download (JSON Lines, oldest first); a line that is not one is skipped. */
export function parseLog(text: string): LoggedCall[] {
  const out: LoggedCall[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e['kind'] !== 'call' || typeof e['call'] !== 'string' || typeof e['subject'] !== 'string' || typeof e['date'] !== 'string') continue;
      const value = e['value'];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const naive = e['naive'];
      out.push({
        at: typeof e['at'] === 'string' ? e['at'] : '',
        date: e['date'],
        call: e['call'],
        subject: e['subject'],
        value,
        naive: typeof naive === 'string' || typeof naive === 'number' ? naive : null,
        build: typeof e['build'] === 'string' ? e['build'] : '',
      });
    } catch {
      // a line cut short: skipped
    }
  }
  return out;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isTally = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isInteger(x) && x >= 0); // def: won, lost, tied

/** A logged call read back as a week's chances, or null when it is not one. */
export function readWeekChances(c: LoggedCall): WeekChances | null {
  if (c.call !== WEEK_CHANCES || typeof c.value !== 'string') return null;
  const [league, monday, opponent] = c.subject.split(':');
  if ((league !== 'nba' && league !== 'wnba') || !monday || !ISO_DAY.test(monday) || mondayOf(monday) !== monday || !/^\d+$/.test(opponent ?? '')) return null;
  try {
    const v = JSON.parse(c.value) as { w?: unknown; c?: unknown; s?: unknown };
    if (!v.c || typeof v.c !== 'object') return null;
    const chances: Record<string, number> = {};
    for (const [label, p] of Object.entries(v.c as Record<string, unknown>)) {
      const cat = LABEL_TO_CAT.get(label);
      if (cat && typeof p === 'number' && p >= 0 && p <= 1) chances[cat] = p;
    }
    if (!Object.keys(chances).length) return null;
    return {
      league,
      monday,
      opponent: Number(opponent),
      week: typeof v.w === 'number' && Number.isInteger(v.w) && v.w > 0 ? v.w : null,
      chances,
      soFar: isTally(v.s) ? v.s : null,
      date: c.date,
      at: c.at,
    };
  } catch {
    return null;
  }
}

/** Each week's first record, by its Monday: the chance at the week's start, or the earliest one made. */
export function firstRecords(calls: readonly LoggedCall[], league: League): Map<string, WeekChances> {
  const out = new Map<string, WeekChances>();
  for (const r of calls.map(readWeekChances)) {
    if (!r || r.league !== league) continue;
    const had = out.get(r.monday);
    if (!had || r.date < had.date || (r.date === had.date && r.at < had.at)) out.set(r.monday, r);
  }
  return out;
}

/**
 * The Yahoo week number of a Monday, counted from the latest import: the week it was still
 * playing (its one unfinished week) was the week of the import's Monday. Null without a Yahoo
 * import holding an unfinished week. A season's longer week (Yahoo's All-Star week) between the
 * import and the Monday would put the count one week out, so a record keeps the number its own
 * week's import gave.
 */
export function yahooWeekOf(source: LeagueSource | undefined, monday: string, dateOf: (ms: number) => string): number | null {
  if (!source || source.host !== 'yahoo' || !source.weeks?.length) return null;
  const open = source.weeks.filter((w) => !w.final).map((w) => w.week);
  if (!open.length) return null;
  const at = mondayOf(dateOf(source.syncedAt));
  const n = Math.max(...open) + Math.round((Date.parse(`${monday}T12:00:00Z`) - Date.parse(`${at}T12:00:00Z`)) / (WEEK_DAYS * DAY_MS));
  return n >= 1 ? n : null;
}

/** The score so far in categories won, lost and tied, from both sides' totals; null when neither side has one. */
export function soFarTally(cats: readonly string[], mine: ScoreSoFar | null | undefined, theirs: ScoreSoFar | null | undefined): [number, number, number] | null {
  if (!mine || !theirs) return null;
  const t: [number, number, number] = [0, 0, 0];
  let any = false;
  for (const c of cats) {
    const a = soFarValue(mine, c);
    const b = soFarValue(theirs, c);
    if (a === null || b === null) continue;
    any = true;
    const r = soFarResult(c, a, b);
    t[r === 'win' ? 0 : r === 'loss' ? 1 : 2] += 1; // def: won, lost, tied
  }
  return any ? t : null;
}

export interface CategoryGrade {
  cat: string;
  chance: number;
  mine: number | null;
  theirs: number | null;
  /** What happened; null when Yahoo gave no total for one side. */
  result: 'win' | 'loss' | 'tie' | null;
  /** The side the chance favoured; null for a 50% chance. */
  favoured: 'mine' | 'theirs' | null;
  /** Whether the favoured side won; null when there was no call (a 50% chance, a tie, no total). */
  right: boolean | null;
}

export interface WeekGrade {
  record: WeekChances;
  cats: CategoryGrade[];
}

/** One week graded: each recorded category's chance against the two teams' final totals. */
export function gradeWeek(record: WeekChances, week: LeagueWeek, mine: number): WeekGrade {
  const a = week.teams[mine] ?? null;
  const b = week.teams[record.opponent] ?? null;
  const cats = Object.entries(record.chances).map(([cat, chance]): CategoryGrade => {
    const x = soFarValue(a, cat);
    const y = soFarValue(b, cat);
    const result = x === null || y === null ? null : soFarResult(cat, x, y);
    const favoured = chance > COIN ? 'mine' : chance < COIN ? 'theirs' : null;
    const right = favoured === null || result === null || result === 'tie' ? null : (favoured === 'mine') === (result === 'win');
    return { cat, chance, mine: x, theirs: y, result, favoured, right };
  });
  return { record, cats };
}

export interface Running {
  weeks: number;
  /** Calls the favoured side won. */
  right: number;
  /** Calls made: a chance off 50% in a category won or lost. */
  made: number;
  /** The mean Brier score over the categories won or lost; null with none. */
  brier: number | null;
  /** The categories the Brier score is over. */
  scored: number;
}

/** The running record over the graded weeks. */
export function running(grades: readonly WeekGrade[]): Running {
  let right = 0;
  let made = 0;
  let sq = 0;
  let scored = 0;
  for (const g of grades) {
    for (const c of g.cats) {
      if (c.right !== null) {
        made += 1;
        if (c.right) right += 1;
      }
      if (c.result === 'win' || c.result === 'loss') {
        const o = c.result === 'win' ? 1 : 0;
        sq += (c.chance - o) ** 2; // def: a squared error
        scored += 1;
      }
    }
  }
  return { weeks: grades.length, right, made, brier: scored ? sq / scored : null, scored };
}

/** Last week on the card: before grading starts, no record, its totals not imported yet, or graded. */
export type LastWeek =
  | { state: 'before'; week: string; firstGrade: string }
  | { state: 'none'; monday: string }
  | { state: 'not-imported'; monday: string; record: WeekChances }
  | { state: 'graded'; monday: string; grade: WeekGrade };

/** The week a record grades against: its own Yahoo week, else the one the latest import counts to. */
function weekFor(record: WeekChances, source: LeagueSource | undefined, dateOf: (ms: number) => string): LeagueWeek | null {
  const n = record.week ?? yahooWeekOf(source, record.monday, dateOf);
  const w = n === null ? undefined : source?.weeks?.find((x) => x.week === n);
  return w && w.final ? w : null;
}

/**
 * Last week and the running record, on `today` (Eastern). Every week from the first graded one
 * that is over, has a record and has its final totals imported counts in the record.
 */
export function lastWeekGraded(
  calls: readonly LoggedCall[],
  league: League,
  source: LeagueSource | undefined,
  mine: number,
  today: string,
  dateOf: (ms: number) => string,
  shipped: string = LOG_SHIPPED,
): { last: LastWeek; running: Running } {
  const { week: first, firstGrade } = gradingStarts(shipped);
  if (today < firstGrade) return { last: { state: 'before', week: first, firstGrade }, running: running([]) };
  const thisMonday = mondayOf(today);
  const records = firstRecords(calls, league);
  const grades: WeekGrade[] = [];
  for (const [monday, record] of [...records].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (monday < first || monday >= thisMonday) continue;
    const week = weekFor(record, source, dateOf);
    if (week) grades.push(gradeWeek(record, week, mine));
  }
  const lastMonday = addDays(thisMonday, -WEEK_DAYS);
  const record = records.get(lastMonday);
  const graded = grades.find((g) => g.record.monday === lastMonday);
  const last: LastWeek = !record
    ? { state: 'none', monday: lastMonday }
    : graded
      ? { state: 'graded', monday: lastMonday, grade: graded }
      : { state: 'not-imported', monday: lastMonday, record };
  return { last, running: running(grades) };
}
