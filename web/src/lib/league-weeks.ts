/**
 * The league, week by week (#1049, #1054): how every team ranks in each category, against the
 * league, from the weeks' totals as Yahoo scored them (the import reads them, #1049). Facts, so they show: no projection, no call.
 *
 * - A week: each team's nine totals (a percentage from its makes and attempts) and its rank in each
 *   category. Ties share a rank (1, 2, 2, 4); turnovers rank low to high.
 * - A team's all-play record for the week, in categories: each category against each other team, a
 *   win, a loss or a tie, as the league's records count them.
 * - The season: each team's average rank per category over the finished weeks, and how it is moving
 *   (the last three finished weeks against the season).
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
  /** The teams a playoff week's Yahoo pages showed no matchup for (#1063), by team index: null in `teams`, and named on the League page. */
  left?: number[];
  /** The teams whose total Yahoo showed blank in a finished week (#1062), by team index: the week is then not final, and is read again. */
  blank?: number[];
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
  /** All-play over the finished weeks, in categories. */
  allPlay: { won: number; lost: number; tied: number };
  weeks: number;
}

/** How many of the latest finished weeks the trend reads. */
const RECENT_WEEKS = 3; // def: the last three finished weeks

/** The season so far: each team's average rank per category over the finished weeks, and its trend. */
export function seasonTable(weeks: readonly LeagueWeek[], teams: number, cats: readonly string[] = CATEGORIES): SeasonRow[] {
  const finished = weeks.filter((w) => w.final).sort((a, b) => a.week - b.week);
  const tables = finished.map((w) => weekTable(w, cats));
  const recent = tables.slice(-RECENT_WEEKS);
  const mean = (xs: (number | null | undefined)[]) => {
    const ok = xs.filter((x): x is number => typeof x === 'number');
    return ok.length ? ok.reduce((s, x) => s + x, 0) / ok.length : null;
  };
  return Array.from({ length: teams }, (_, team) => {
    const average: Record<string, number | null> = {};
    const trend: Record<string, number | null> = {};
    for (const c of cats) {
      const all = mean(tables.map((t) => t[team]?.ranks[c]));
      const last = mean(recent.map((t) => t[team]?.ranks[c]));
      average[c] = all;
      trend[c] = all !== null && last !== null && tables.length > RECENT_WEEKS ? last - all : null;
    }
    const allPlay = tables.reduce(
      (s, t) => {
        const a = t[team]?.allPlay;
        return a ? { won: s.won + a.won, lost: s.lost + a.lost, tied: s.tied + a.tied } : s;
      },
      { won: 0, lost: 0, tied: 0 },
    );
    return { team, average, trend, allPlay, weeks: tables.length };
  });
}

/** A category's total as the table shows it: a percentage to a tenth, a count whole. */
export function showTotal(cat: string, v: number | null): string {
  if (v === null) return '–';
  return isRatio(cat) ? `${(v * 100).toFixed(1)}%` : String(Math.round(v));
}
