/**
 * What the Yahoo bookmark reads beyond the rosters (#874), from pages of the manager's own league
 * in their own signed-in browser: the standings on the league's home page, this week's matchup
 * with its score so far, and the playoffs and scoring type on the settings page. The bookmark
 * sends each page's text as it stands (a table's labels and cells, a setting's line), and this
 * module turns it into the league's state, so a change in Yahoo's wording fails here, in tests,
 * rather than in the bookmark.
 */
import type { Format, Tally } from './fantasy-league';
import type { ScoreSoFar } from './matchup';
import type { TeamRecord } from './records';

/** The extra pages as the bookmark read them; each is missing when its page did not answer. */
export interface YahooPages {
  /** Each team's W-L-T and rank in the standings table, by Yahoo's team id. */
  records?: Record<string, [string, string]>;
  /** This week's matchup table: its column labels, and each side's team id and cells. */
  matchup?: { labels: string[]; rows: { id: number; cells: string[] }[] };
  /** The settings page's lines, e.g. playoffs "6 teams - Week 20, 21 and 22 (ends Sunday, Apr 4)". */
  settings?: { playoffs?: string; scoring?: string };
}

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');

/** The extra pages from a bookmark's payload, keeping what is well formed. */
export function cleanYahooPages(raw: { records?: unknown; matchup?: unknown; settings?: unknown }): YahooPages {
  const out: YahooPages = {};
  if (raw.records && typeof raw.records === 'object') {
    const entries = Object.entries(raw.records as Record<string, unknown>).filter((e): e is [string, [string, string]] => strings(e[1]) && e[1].length === 2); // def: a record and a rank
    if (entries.length) out.records = Object.fromEntries(entries);
  }
  const m = raw.matchup as { labels?: unknown; rows?: unknown } | null | undefined;
  if (m && strings(m.labels) && Array.isArray(m.rows)) {
    const rows = (m.rows as { id?: unknown; cells?: unknown }[]).filter((r) => typeof r?.id === 'number' && strings(r.cells)) as { id: number; cells: string[] }[];
    if (rows.length === 2) out.matchup = { labels: m.labels, rows }; // def: a matchup has two sides
  }
  const s = raw.settings as { playoffs?: unknown; scoring?: unknown } | null | undefined;
  if (s && typeof s === 'object') {
    out.settings = {
      ...(typeof s.playoffs === 'string' ? { playoffs: s.playoffs } : {}),
      ...(typeof s.scoring === 'string' ? { scoring: s.scoring } : {}),
    };
  }
  return out;
}

/** A standings row's "12-6-0" and rank as a record; null when either is not Yahoo's shape. */
export function yahooRecord(wlt: string, rank: string): TeamRecord | null {
  const m = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(wlt.trim());
  if (!m) return null;
  const seed = Number.parseInt(rank, 10);
  return { wins: Number(m[1]), losses: Number(m[2]), ties: Number(m[3] ?? 0), seed: Number.isInteger(seed) && seed > 0 ? seed : null };
}

/** The board's category behind each column of Yahoo's matchup table; FG% and FT% come from the made and attempted. */
const COUNTING: Record<string, string> = {
  PTS: 'z_points',
  REB: 'z_rebounds_total',
  AST: 'z_assists',
  ST: 'z_steals',
  STL: 'z_steals',
  BLK: 'z_blocks',
  '3PTM': 'z_three_pointers_made',
  TO: 'z_turnovers',
};
const SHOTS: Record<string, string> = { 'FGM/A': 'z_field_goal_pct', 'FTM/A': 'z_free_throw_pct' };

/**
 * One side's score so far from the matchup table's labels and its row's cells. Yahoo marks a
 * column shown only for reference with an asterisk (FGM/A*); the made and attempted still give
 * the percentage. A cell with no number yet ("-") is left out.
 */
export function yahooScore(labels: string[], cells: string[]): ScoreSoFar {
  const totals: Record<string, number> = {};
  const shots: Record<string, [number, number]> = {};
  labels.forEach((raw, i) => {
    const label = raw.replace(/\*$/, '').trim().toUpperCase();
    const cell = (cells[i] ?? '').trim();
    const counting = COUNTING[label];
    if (counting && /^-?\d+(\.\d+)?$/.test(cell)) totals[counting] = Number(cell);
    const ratio = SHOTS[label];
    const pair = /^(\d+)\/(\d+)$/.exec(cell);
    if (ratio && pair) shots[ratio] = [Number(pair[1]), Number(pair[2])];
  });
  return { totals, shots };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = 86_400_000; // def: a day in ms

/**
 * The playoffs from the settings line "6 teams - Week 20, 21 and 22 (ends Sunday, Apr 4)": the
 * teams, Yahoo's first and last playoff week, and their dates. The end date has no year: it is
 * the next one on or after the import, give or take the weeks the playoffs take, so a re-import
 * during them keeps this season's. Null when the line is not Yahoo's shape.
 */
export function yahooPlayoffs(line: string, now: number): { teams: number; weeks: number; periods: [number, number]; from: string; to: string } | null {
  const teams = /(\d+)\s+teams/i.exec(line);
  const list = /weeks?\s+([\d,\sand]+)/i.exec(line);
  const end = /ends\s+\w+,\s+([A-Za-z]{3})\w*\s+(\d{1,2})/i.exec(line);
  if (!teams || !list || !end) return null;
  const numbers = (list[1] ?? '').match(/\d+/g)?.map(Number) ?? [];
  const month = MONTHS.indexOf((end[1] ?? '').toLowerCase());
  if (!numbers.length || month < 0) return null;
  const weeks = numbers.length;
  const back = weeks * 7 - 1; // def: a fantasy week is seven days, the first one's Monday to the last one's Sunday
  const year = new Date(now).getUTCFullYear();
  const at = (y: number) => Date.UTC(y, month, Number(end[2]));
  const last = at(year) + DAY >= now - back * DAY ? at(year) : at(year + 1);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { teams: Number(teams[1]), weeks, periods: [numbers[0]!, numbers.at(-1)!], from: iso(last - back * DAY), to: iso(last) };
}

/** The format and how the records count from the settings' scoring type, e.g. "Head-to-Head - Categories". */
export function yahooScoring(line: string): { format: Format; tally: Tally } | null {
  if (/rotisserie/i.test(line)) return { format: 'roto', tally: 'categories' };
  if (!/head-to-head/i.test(line)) return null;
  // "Head-to-Head - Categories" scores each category; "One Win" and "Points" one result a week
  return { format: 'h2h', tally: /categor/i.test(line) && !/one win/i.test(line) ? 'categories' : 'matchups' };
}
