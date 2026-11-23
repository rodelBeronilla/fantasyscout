/**
 * The league, week by week (#1049, #1054): how every team ranks in each category, against the
 * league, from the weeks' totals as Yahoo scored them (the import reads them, #1049). Facts, so they show: no projection, no call.
 *
 * - A week: each team's nine totals (a percentage from its makes and attempts) and its rank in each
 *   category. Ties share a rank (1, 2, 2, 4); turnovers rank low to high.
 * - A team's all-play record for the week, in categories: each category against each other team, a
 *   win, a loss or a tie, as the league's records count them.
 * - The season: each team's average rank per category over the finished weeks, and how it is moving
 *   (the last three finished weeks against the season), compared in whole numbers so the half-rank
 *   edge is exact (#1064).
 * - The teams Yahoo gave no totals for in a week, so the page names them (#1064).
 */
import { CATEGORIES } from './format';
import { isRatio, type ScoreSoFar, soFarResult, soFarValue } from './matchup';

/** One fantasy week as the import read it: each team's score by index, null where Yahoo gave none. */
export interface LeagueWeek {
  week: number;
  /** Each team's totals, by team index. */
  teams: (ScoreSoFar | null)[];
  /** The week is over: its totals are final, unless a stat correction moves them. */
  final: boolean;
  /** The teams whose playoff-week page on Yahoo showed other matchups and not them (#1063), by team index: null in `teams`, and named on the League page. */
  left?: number[];
  /** The teams whose total Yahoo showed blank in a finished week (#1062), by team index: the week is not final, and is read again, until a read from its Tuesday on finds the same blanks. */
  blank?: number[];
}

/**
 * Why the weeks' reading stopped at a page (#1063, #1123); none: the page did not answer.
 * 'not-matchup': it answered with a page that is not a matchup page (Yahoo's error page);
 * 'other-week': with another week's matchup page; 'no-totals': with this week's page and no
 * category table the bookmark can read; 'not-shown': with a table that does not show the team.
 */
const STOP_REASONS = ['not-shown', 'not-matchup', 'other-week', 'no-totals'] as const;
type StopReason = (typeof STOP_REASONS)[number];

/** Where an import's reading of the weeks stopped (#1049): its week and its path in the league, and why (#1123). */
export interface WeeksStop {
  week: number;
  page: string;
  why?: StopReason;
  /** The week the page said it shows, when it was another week's (#1123). */
  shows?: number;
  /** Yahoo's settings page did not answer, so the bookmark could not tell whether the playoffs had begun (#1123). */
  noSettings?: boolean;
  /** The asked team's name at the import (#1063). */
  team?: string;
}

/** A stop as read from a payload or a stored copy (#1123): the optional parts only where well formed. */
export function stopDetails(raw: { why?: unknown; shows?: unknown; noSettings?: unknown }): Pick<WeeksStop, 'why' | 'shows' | 'noSettings'> {
  const why = STOP_REASONS.find((r) => r === raw.why);
  const shows = typeof raw.shows === 'number' && Number.isInteger(raw.shows) && raw.shows > 0 && raw.shows <= 30 ? raw.shows : undefined; // def: a season has fewer fantasy weeks
  return { ...(why ? { why } : {}), ...(why === 'other-week' && shows ? { shows } : {}), ...(why === 'not-shown' && raw.noSettings === true ? { noSettings: true } : {}) };
}

export interface WeekRow {
  team: number;
  /** Each category's total (a percentage as a fraction), null where Yahoo gave none. */
  values: Record<string, number | null>;
  /** Each category's rank among the teams that have a value: 1 is best. */
  ranks: Record<string, number | null>;
  /** All-play in categories: against each other team, each category won, lost or tied. */
  allPlay: { won: number; lost: number; tied: number };
}

const LOWER_BETTER = new Set(['z_turnovers']);

/** Competition ranks: the best is 1, ties share a rank, and the next rank skips them (1, 2, 2, 4). */
export function rank(values: (number | null)[], lowerBetter: boolean): (number | null)[] {
  return values.map((v) => {
    if (v === null) return null;
    const better = values.filter((o) => o !== null && (lowerBetter ? o < v : o > v)).length;
    return better + 1;
  });
}

/** A week's table: every team's totals, ranks and all-play record. */
export function weekTable(week: LeagueWeek, cats: readonly string[] = CATEGORIES): WeekRow[] {
  const values = week.teams.map((score) => Object.fromEntries(cats.map((c) => [c, soFarValue(score, c)])) as Record<string, number | null>);
  const ranks = values.map(() => ({}) as Record<string, number | null>);
  for (const c of cats) {
    const r = rank(
      values.map((v) => v[c] ?? null),
      LOWER_BETTER.has(c),
    );
    r.forEach((x, i) => (ranks[i]![c] = x));
  }
  return values.map((v, team) => {
    const allPlay = { won: 0, lost: 0, tied: 0 };
    values.forEach((other, o) => {
      if (o === team || !week.teams[o] || !week.teams[team]) return;
      for (const c of cats) {
        const a = v[c];
        const b = other[c];
        if (a === null || a === undefined || b === null || b === undefined) continue;
        const result = soFarResult(c, a, b);
        if (result === 'win') allPlay.won += 1;
        else if (result === 'loss') allPlay.lost += 1;
        else allPlay.tied += 1;
      }
    });
    return { team, values: v, ranks: ranks[team]!, allPlay };
  });
}

export interface SeasonRow {
  team: number;
  /** Each category's average rank over the finished weeks. */
  average: Record<string, number | null>;
  /** Each category's average rank over the last three finished weeks, less the season's: negative is rising. */
  trend: Record<string, number | null>;
  /** The trend as the page marks it: half a rank or more better (rising) or worse (falling), exactly. */
  move: Record<string, 'rising' | 'falling' | null>;
  /** All-play over the finished weeks, in categories. */
  allPlay: { won: number; lost: number; tied: number };
  /** The finished weeks Yahoo gave this team's totals for. */
  weeks: number;
}

/** How many of the latest finished weeks the trend reads. */
const RECENT_WEEKS = 3; // def: the last three finished weeks
/** The trend's edge, half a rank, as a fraction: ranks are whole numbers, so the comparison stays in integers. */
const EDGE_DENOMINATOR = 2; // def: half a rank

/**
 * Rising or falling: the recent mean (sumLast / nLast) against the season's (sumAll / nAll), with
 * the half-rank edge compared exactly as 2 × (sumLast × nAll − sumAll × nLast) against nLast × nAll.
 */
function moveOf(all: number[], last: number[]): 'rising' | 'falling' | null {
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const gap = EDGE_DENOMINATOR * (sum(last) * all.length - sum(all) * last.length);
  const edge = last.length * all.length;
  return gap <= -edge ? 'rising' : gap >= edge ? 'falling' : null;
}

/** The season so far: each team's average rank per category over the finished weeks, and its trend. */
export function seasonTable(weeks: readonly LeagueWeek[], teams: number, cats: readonly string[] = CATEGORIES): SeasonRow[] {
  const finished = weeks.filter((w) => w.final).sort((a, b) => a.week - b.week);
  const tables = finished.map((w) => weekTable(w, cats));
  const recent = tables.slice(-RECENT_WEEKS);
  const known = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === 'number');
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return Array.from({ length: teams }, (_, team) => {
    const average: Record<string, number | null> = {};
    const trend: Record<string, number | null> = {};
    const move: Record<string, 'rising' | 'falling' | null> = {};
    for (const c of cats) {
      const allRanks = known(tables.map((t) => t[team]?.ranks[c]));
      const lastRanks = known(recent.map((t) => t[team]?.ranks[c]));
      const all = mean(allRanks);
      const last = mean(lastRanks);
      const reads = all !== null && last !== null && tables.length > RECENT_WEEKS;
      average[c] = all;
      trend[c] = reads ? last - all : null;
      move[c] = reads ? moveOf(allRanks, lastRanks) : null;
    }
    const allPlay = tables.reduce(
      (s, t) => {
        const a = t[team]?.allPlay;
        return a ? { won: s.won + a.won, lost: s.lost + a.lost, tied: s.tied + a.tied } : s;
      },
      { won: 0, lost: 0, tied: 0 },
    );
    return { team, average, trend, move, allPlay, weeks: finished.filter((w) => w.teams[team]).length };
  });
}

/** The teams Yahoo gave no totals for, each with the weeks it is missing from (#1064). */
export function missingWeeks(weeks: readonly LeagueWeek[], teams: number): { team: number; weeks: number[] }[] {
  return Array.from({ length: teams }, (_, team) => ({ team, weeks: weeks.filter((w) => !w.teams[team]).map((w) => w.week) })).filter((m) => m.weeks.length > 0);
}

/** A category's total as the table shows it: a percentage to a tenth, a count whole. */
export function showTotal(cat: string, v: number | null): string {
  if (v === null) return '–';
  return isRatio(cat) ? `${(v * 100).toFixed(1)}%` : String(Math.round(v));
}
