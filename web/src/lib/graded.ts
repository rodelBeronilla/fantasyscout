/**
 * Last week, graded (#1058): for the owner with his preview on, each category's chance at the
 * week's start against what happened, and a running record over the graded weeks.
 *
 * - The chance is My Team's matchup card's (validated, ADR 0026), logged with the preview's calls
 *   (owner-preview.ts), one entry a category, under the log's present form: the batch calls file,
 *   each entry kept once by its key (worker/src/owner-log-event.ts). The chance at the week's
 *   start is each category's earliest entry that week; one first logged after the Monday is a
 *   mid-week one, and the card says so.
 * - What happened is the week's final totals as Yahoo scored them (the import's weeks, #1049),
 *   compared category by category as the matchup card compares a score so far (soFarResult). A
 *   category with no total for one side is named and left ungraded, never a loss.
 * - A call is the side a chance favours. A 50% chance, or a category tied, is no call. The Brier
 *   score is the mean of (chance − result)², 1 for a category won and 0 for one lost, over the
 *   categories won or lost; a coin's 50% scores 0.25 on every one.
 * - Nothing from before the log's present form is graded: only batch entries (they carry the
 *   league's import), from the first full week after it shipped.
 */
import { callKey } from '../../../worker/src/owner-log-event';
import type { League } from './data';
import { mondayOf, type LeagueSource } from './fantasy-league';
import type { LeagueWeek } from './league-weeks';
import { type ScoreSoFar, soFarResult, soFarValue } from './matchup';
import { previewCall, type PreviewCall } from './owner-preview';

/** The day the log's present form shipped (#1057 merged, Eastern): grading starts with the first full fantasy week after it. */
const LOG_SHIPPED = '2026-11-22'; // def: #1057 merged on Sunday 2026-11-22

/** The call the week's chances are logged under, one entry a category. */
export const WEEK_CHANCE = 'week-chance';

/** A coin's chance, and its Brier score on any category won or lost. */
const COIN = 1 / 2; // def: a coin flip
export const COIN_BRIER = COIN * COIN; // def: (0.5 − 0 or 1)², whatever happens

const DAY_MS = 86_400_000; // def: a day in ms
const WEEK_DAYS = 7; // def: a fantasy week, Monday to Sunday

/** The date `days` after an ISO date. */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10); // def: YYYY-MM-DD
}

/** The first week graded (its Monday: the first Monday on or after the log's present form shipped) and the day its grade first shows (the Monday after). */
export function gradingStarts(shipped: string = LOG_SHIPPED): { week: string; firstGrade: string } {
  const monday = mondayOf(shipped);
  const week = monday === shipped ? monday : addDays(monday, WEEK_DAYS);
  return { week, firstGrade: addDays(week, WEEK_DAYS) };
}

/** A call entry of the owner's log in its present form, as its download holds it, with the key the log keeps it under. */
export interface LoggedCall {
  key: string;
  at: string;
  date: string;
  call: string;
  subject: string;
  value: number | string;
  naive: number | string | null;
  build: string;
  /** The league's import it was made for. */
  league: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The call entries in the log's download (JSON Lines, oldest first). Only the present form's: an
 * entry from a batch, which names the league's import; an older single call, and any line that is
 * not a call, is skipped.
 */
export function parseLog(text: string): LoggedCall[] {
  const out: LoggedCall[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const { call, subject, date, value, naive, league } = e;
      if (e['kind'] !== 'call' || typeof call !== 'string' || typeof subject !== 'string' || typeof date !== 'string' || !ISO_DAY.test(date)) continue;
      if (typeof league !== 'string' || (typeof value !== 'string' && typeof value !== 'number')) continue;
      out.push({
        key: callKey(e),
        at: typeof e['at'] === 'string' ? e['at'] : '',
        date,
        call,
        subject,
        value,
        naive: typeof naive === 'string' || typeof naive === 'number' ? naive : null,
        build: typeof e['build'] === 'string' ? e['build'] : '',
        league,
      });
    } catch {
      // a line cut short: skipped
    }
  }
  return out;
}

/** A week's chances, as its earliest entries in the log hold them. */
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
  /** The log entry each chance is, by category: a grade is tied to its entry by this key. */
  keys: Record<string, string>;
  /** The score so far when it was first logged, in categories won, lost and tied; null without one. */
  soFar: [number, number, number] | null;
  /** The Eastern date the earliest chance was logged: after the Monday, a mid-week record. */
  date: string;
  /** When the log took it, ISO. */
  at: string;
}

/** The entries for a week's chances: one a category (its chance, the naive a coin's), the Yahoo week, and the score so far when there is one. */
export function weekChanceCalls(c: Pick<WeekChances, 'league' | 'monday' | 'opponent' | 'week' | 'chances' | 'soFar'>): PreviewCall[] {
  const base = `${c.league} ${c.monday} vs ${c.opponent}`;
  return [
    ...Object.entries(c.chances).map(([cat, p]) => previewCall({ call: WEEK_CHANCE, subject: `${base} ${cat}`, value: Number(p.toFixed(3)), naive: COIN })), // def: a chance to a thousandth
    previewCall({ call: WEEK_CHANCE, subject: `${base} yahoo-week`, value: c.week === null ? 'not known' : `week ${c.week}` }),
    ...(c.soFar ? [previewCall({ call: WEEK_CHANCE, subject: `${base} so-far`, value: c.soFar.join('-') })] : []),
  ];
}

const SUBJECT = /^(?<league>nba|wnba) (?<monday>\d{4}-\d{2}-\d{2}) vs (?<opp>\d+) (?<part>\S+)$/;
/** A week-chance subject's parts. */
const partsOf = (subject: string) => SUBJECT.exec(subject)?.groups as { league: string; monday: string; opp: string; part: string } | undefined;
const earlier = (a: LoggedCall, b: LoggedCall) => a.date < b.date || (a.date === b.date && a.at < b.at);

/** Each week's chances, by its Monday: each category's earliest entry, against the opponent of the week's earliest one. */
export function weekRecords(calls: readonly LoggedCall[], league: League): Map<string, WeekChances> {
  const byWeek = new Map<string, LoggedCall[]>();
  for (const c of calls) {
    const m = c.call === WEEK_CHANCE ? partsOf(c.subject) : undefined;
    if (!m || m.league !== league || mondayOf(m.monday) !== m.monday) continue;
    byWeek.set(m.monday, [...(byWeek.get(m.monday) ?? []), c]);
  }
  const out = new Map<string, WeekChances>();
  for (const [monday, entries] of byWeek) {
    const first = entries.reduce((a, b) => (earlier(b, a) ? b : a));
    const opponent = Number(partsOf(first.subject)!.opp);
    const chances: Record<string, number> = {};
    const keys: Record<string, string> = {};
    const firstOf = new Map<string, LoggedCall>();
    for (const c of entries) {
      const { opp, part } = partsOf(c.subject)!;
      if (Number(opp) !== opponent) continue;
      const had = firstOf.get(part);
      if (!had || earlier(c, had)) firstOf.set(part, c);
    }
    let week: number | null = null;
    let soFar: [number, number, number] | null = null;
    for (const [part, c] of firstOf) {
      if (part === 'yahoo-week') {
        const n = /^week (\d+)$/.exec(String(c.value));
        week = n ? Number(n[1]) : null;
      } else if (part === 'so-far') {
        const t = String(c.value).split('-').map(Number);
        soFar = t.length === 3 && t.every((x) => Number.isInteger(x) && x >= 0) ? (t as [number, number, number]) : null; // def: won, lost, tied
      } else if (typeof c.value === 'number' && c.value >= 0 && c.value <= 1) {
        chances[part] = c.value;
        keys[part] = c.key;
      }
    }
    if (Object.keys(chances).length) out.set(monday, { league, monday, opponent, week, chances, keys, soFar, date: first.date, at: first.at });
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
  /** The log entry the chance is. */
  key: string;
  chance: number;
  mine: number | null;
  theirs: number | null;
  /** What happened; null when Yahoo gave no total for one side. */
  result: 'win' | 'loss' | 'tie' | null;
  /** Whose total is missing, when one is: the category is then named and not graded. */
  missing: 'mine' | 'theirs' | 'both' | null;
  /** The side the chance favoured; null for a 50% chance. */
  favoured: 'mine' | 'theirs' | null;
  /** Whether the favoured side won; null when there was no call (a 50% chance, a tie, no total). */
  right: boolean | null;
}

export interface WeekGrade {
  record: WeekChances;
  cats: CategoryGrade[];
  /** The week's totals it was graded against. */
  week: LeagueWeek;
}

/** One week graded: each recorded category's chance against the two teams' final totals. */
export function gradeWeek(record: WeekChances, week: LeagueWeek, mine: number): WeekGrade {
  const a = week.teams[mine] ?? null;
  const b = week.teams[record.opponent] ?? null;
  const cats = Object.entries(record.chances).map(([cat, chance]): CategoryGrade => {
    const x = soFarValue(a, cat);
    const y = soFarValue(b, cat);
    const missing = x === null && y === null ? 'both' : x === null ? 'mine' : y === null ? 'theirs' : null;
    const result = missing ? null : soFarResult(cat, x!, y!);
    const favoured = chance > COIN ? 'mine' : chance < COIN ? 'theirs' : null;
    const right = favoured === null || result === null || result === 'tie' ? null : (favoured === 'mine') === (result === 'win');
    return { cat, key: record.keys[cat] ?? '', chance, mine: x, theirs: y, result, missing, favoured, right };
  });
  return { record, cats, week };
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

/** Last week on the card: before grading starts, no record, its totals not imported, or graded. */
export type LastWeek =
  | { state: 'before'; week: string; firstGrade: string }
  | { state: 'none'; monday: string }
  | { state: 'not-imported'; monday: string; record: WeekChances; yahooWeek: number | null }
  | { state: 'graded'; monday: string; grade: WeekGrade };

/** The week a record grades against: its own Yahoo week, else the one the latest import counts to; null when the import does not hold it final. */
export function weekFor(record: WeekChances, source: LeagueSource | undefined, dateOf: (ms: number) => string): LeagueWeek | null {
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
  // nothing from before the first graded week
  const records = weekRecords(
    calls.filter((c) => c.date >= first),
    league,
  );
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
      : { state: 'not-imported', monday: lastMonday, record, yahooWeek: record.week ?? yahooWeekOf(source, lastMonday, dateOf) };
  return { last, running: running(grades) };
}
