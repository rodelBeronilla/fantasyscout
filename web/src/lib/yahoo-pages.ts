/**
 * What the Yahoo bookmark reads beyond the rosters (#874), from pages of the manager's own league
 * in their own signed-in browser: the standings on the league's home page, this week's matchup
 * with its score so far, and the playoffs and scoring type on the settings page. The bookmark
 * sends each page's text as it stands (a table's labels and cells, a setting's line), and this
 * module turns it into the league's state, so a change in Yahoo's wording fails here, in tests,
 * rather than in the bookmark.
 */
import type { Format, Tally } from './fantasy-league';
import type { LeagueWeek } from './league-weeks';
import type { ScoreSoFar } from './matchup';
import type { TeamRecord } from './records';

/** The extra pages as the bookmark read them; each is missing when its page did not answer. */
export interface YahooPages {
  /** Each team's W-L-T and rank in the standings table, by Yahoo's team id. */
  records?: Record<string, [string, string]>;
  /** This week's matchup table: its column labels, and each side's team id and cells. */
  matchup?: { labels: string[]; rows: { id: number; cells: string[] }[] };
  /** The settings page's lines, e.g. playoffs "6 teams - Week 20, 21 and 22 (ends Sunday, Apr 4)"; every label and value since version 4 (#1018). */
  settings?: { playoffs?: string; scoring?: string; rows?: [string, string][] };
  /** The manager's team page's line on this week's adds, as it stands: "You have used 0 of your 4 player adds for this week." (#1028). */
  adds?: string;
  /** The adds used this week and the weekly limit, as numbers read from that line (#1061): the bookmark sends these, not the text. */
  addsCount?: [number, number];
  /** The week pages' table labels, when every page has the same (#1049). */
  weekLabels?: string[];
  /** Every week's matchup pages as read (#1049): each page's two rows, and its own labels where they differ from `weekLabels`. */
  weeks?: YahooWeekRead[];
  /**
   * The first week page that did not answer (#1049): its week and its path in the league, e.g.
   * "matchup?week=3&mid1=2"; with `why: 'not-shown'` when it answered without the team asked
   * for (#1063). Optional, so a payload without it still reads.
   */
  weeksStop?: WeeksStop;
}

/** Where the weeks' reading stopped (#1049, #1063). */
interface WeeksStop {
  week: number;
  page: string;
  why?: 'not-shown';
}

/** One week's matchup pages as the bookmark read them (#1049); `final` once the week is over. */
interface YahooWeekRead {
  week: number;
  final: boolean;
  pages: { labels?: string[]; rows: { id: number; cells: string[] }[] }[];
  /** The teams a playoff week's pages answered without (#1063): out of the playoffs that week, by Yahoo's id. */
  left?: number[];
}

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');

/** The extra pages from a bookmark's payload, keeping what is well formed. */
export function cleanYahooPages(raw: { records?: unknown; matchup?: unknown; settings?: unknown; adds?: unknown; addsCount?: unknown; weekLabels?: unknown; weeks?: unknown; weeksStop?: unknown }): YahooPages {
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
  const s = raw.settings as { playoffs?: unknown; scoring?: unknown; rows?: unknown } | null | undefined;
  if (s && typeof s === 'object') {
    const rows = Array.isArray(s.rows)
      ? (s.rows as unknown[]).filter((r): r is [string, string] => strings(r) && r.length === 2).slice(0, 80) // def: the settings page's rows, at most
      : [];
    out.settings = {
      ...(typeof s.playoffs === 'string' ? { playoffs: s.playoffs } : {}),
      ...(typeof s.scoring === 'string' ? { scoring: s.scoring } : {}),
      ...(rows.length ? { rows } : {}),
    };
  }
  if (typeof raw.adds === 'string' && raw.adds.length <= 200) out.adds = raw.adds; // def: a sentence, at most
  const count = raw.addsCount;
  if (Array.isArray(count) && count.length === 2 && count.every((n) => Number.isInteger(n) && n >= 0 && n <= 99)) out.addsCount = [count[0] as number, count[1] as number]; // def: two small counts
  Object.assign(out, cleanWeeks(raw));
  return out;
}

const MAX_WEEK = 30; // def: a season has fewer fantasy weeks
const MAX_PAGES = 10; // def: twenty teams, the most a league has, make ten matchups a week
const MAX_CELLS = 20; // def: a matchup table's columns, at most
const MAX_CELL = 60; // def: a cell's text (a team's name), at most
const isWeek = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= MAX_WEEK;
/** A table row's cells, each cut to a team name's length (a total is far shorter); null when they are not a row. */
const cellsIn = (x: unknown): string[] | null => (strings(x) && x.length <= MAX_CELLS ? x.map((c) => c.slice(0, MAX_CELL)) : null);

/** The week pages from a bookmark's payload (#1049): a week is kept whole or not at all, a page only with its two rows. */
function cleanWeeks(raw: { weekLabels?: unknown; weeks?: unknown; weeksStop?: unknown }): Pick<YahooPages, 'weekLabels' | 'weeks' | 'weeksStop'> {
  const out: Pick<YahooPages, 'weekLabels' | 'weeks' | 'weeksStop'> = {};
  const labels = cellsIn(raw.weekLabels) ?? undefined;
  const page = (p: unknown) => {
    const x = p as { labels?: unknown; rows?: unknown } | null;
    // def: a matchup has two sides, or one in a playoff week where a team has a bye
    if (!x || typeof x !== 'object' || !Array.isArray(x.rows) || x.rows.length < 1 || x.rows.length > 2) return null;
    const rows = (x.rows as { id?: unknown; cells?: unknown }[]).flatMap((r) => {
      const cells = cellsIn(r?.cells);
      return typeof r?.id === 'number' && Number.isInteger(r.id) && cells ? [{ id: r.id, cells }] : [];
    });
    const own = cellsIn(x.labels) ?? undefined;
    if (rows.length !== x.rows.length || !(own ?? labels)) return null;
    return { ...(own ? { labels: own } : {}), rows };
  };
  const weeks: YahooWeekRead[] = [];
  for (const w of Array.isArray(raw.weeks) ? (raw.weeks as unknown[]).slice(0, MAX_WEEK) : []) {
    const x = w as { week?: unknown; final?: unknown; pages?: unknown } | null;
    if (!x || !isWeek(x.week) || typeof x.final !== 'boolean' || !Array.isArray(x.pages) || !x.pages.length || x.pages.length > MAX_PAGES) continue;
    const pages = x.pages.map(page);
    const left = Array.isArray((x as { left?: unknown }).left) ? ((x as { left: unknown[] }).left.filter((id) => Number.isInteger(id)) as number[]).slice(0, 2 * MAX_PAGES) : [];
    if (pages.every((p) => p !== null) && !weeks.some((k) => k.week === x.week)) weeks.push({ week: x.week, final: x.final, pages: pages as YahooWeekRead['pages'], ...(left.length ? { left } : {}) });
  }
  if (weeks.length) {
    if (labels) out.weekLabels = labels;
    out.weeks = weeks.sort((a, b) => a.week - b.week);
  }
  const stop = raw.weeksStop as { week?: unknown; page?: unknown; why?: unknown } | null | undefined;
  if (stop && isWeek(stop.week) && typeof stop.page === 'string' && /^matchup\?week=\d{1,2}&mid1=\d{1,3}$/.test(stop.page))
    out.weeksStop = { week: stop.week, page: stop.page, ...(stop.why === 'not-shown' ? { why: stop.why } : {}) };
  // the home page did not answer, or showed no matchup links: no week was read
  if (stop && stop.week === 0 && (stop.page === 'home' || stop.page === 'home-no-matchups')) out.weeksStop = { week: 0, page: stop.page };
  return out;
}

/**
 * Every week's matchup totals from the week pages (#1049), each team's by its index in `ids`
 * (Yahoo's team ids in the payload's order). A team no page shows is null that week.
 */
export function yahooWeeks(pages: YahooPages, ids: number[]): LeagueWeek[] {
  return (pages.weeks ?? []).flatMap((w) => {
    const teams: (ScoreSoFar | null)[] = ids.map(() => null);
    const left = (w.left ?? []).map((id) => ids.indexOf(id)).filter((i) => i >= 0);
    for (const p of w.pages) {
      const labels = p.labels ?? pages.weekLabels ?? [];
      for (const r of p.rows) {
        const i = ids.indexOf(r.id);
        if (i >= 0) teams[i] = yahooScore(labels, r.cells);
      }
    }
    return teams.some(Boolean) ? [{ week: w.week, teams, final: w.final, ...(left.length ? { left } : {}) }] : [];
  });
}

/** "1–3, 5" for weeks 1, 2, 3 and 5. */
function weekRanges(weeks: number[]): string {
  const runs: [number, number][] = [];
  for (const w of [...weeks].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && last[1] === w - 1) last[1] = w;
    else runs.push([w, w]);
  }
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ');
}

/**
 * The League page's lines on the weeks the import holds (#1049): which are final and which is so
 * far, and the page that did not answer, if one did not.
 */
export function weeksLines(
  source: { weeks?: LeagueWeek[]; weeksStop?: { week: number; page: string; why?: 'not-shown'; team?: string } },
  names: string[] = [],
): { read: string | null; stop: string | null; left: string | null } {
  const weeks = source.weeks ?? [];
  const final = weeks.filter((w) => w.final).map((w) => w.week);
  const soFar = weeks.filter((w) => !w.final).map((w) => w.week);
  const named = (ws: number[]) => `${ws.length === 1 ? 'week' : 'weeks'} ${weekRanges(ws)}`;
  const parts = [...(final.length ? [`${named(final)} final`] : []), ...(soFar.length ? [`${named(soFar)} so far`] : [])];
  const stop = source.weeksStop;
  // the team by its name at the import (#1063); a copy from before keeps Yahoo's number
  const team = stop?.team ?? `Yahoo's team ${(stop ? /mid1=(\d+)/.exec(stop.page)?.[1] : undefined) ?? '?'}`;
  // the weeks a home-page stop leaves are the earlier import's, and the line above says which
  const kept = weeks.length ? '; the weeks above are from the import before' : '';
  const stopLine = !stop
    ? null
    : stop.page === 'home'
      ? `Yahoo's league home page did not answer, so no week's matchups were read this time${kept}. Run the bookmark again later.`
      : stop.page === 'home-no-matchups'
        ? `Yahoo's league home page showed no matchups (between seasons, or Yahoo changed the page), so no week's matchups were read this time${kept}. Run the bookmark again once Yahoo shows this week's matchups.`
        : stop.why === 'not-shown'
          ? `Yahoo's matchup page for week ${stop.week} did not show ${team}, so that week and the ones after it were not read; run the bookmark again later.`
          : `Yahoo did not answer the matchup page for week ${stop.week} (${team}), so that week and the ones after it were not read; run the bookmark again later.`;
  // the teams a playoff week's pages left out (#1063), by name
  const left = weeks.flatMap((w) => {
    const who = (w.left ?? []).map((i) => names[i] || `Team ${i + 1}`);
    return who.length ? [`${who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)}` : who[0]} in week ${w.week}`] : [];
  });
  return {
    read: parts.length ? `Every matchup's category totals from Yahoo: ${parts.join(', ')}.` : null,
    stop: stopLine,
    left: left.length ? `No playoff matchup on Yahoo, so no totals: ${left.join('; ')}.` : null,
  };
}

/**
 * The adds used this week and the weekly limit from the team page's line (#1028), e.g. "You have
 * used 0 of your 4 player adds for this week."; null when the line is not Yahoo's wording.
 */
export function yahooAddsUsed(line: string): { used: number; limit: number } | null {
  const m = /used (\d+) of (?:your )?(\d+) player adds?/i.exec(line);
  return m ? { used: Number(m[1]), limit: Number(m[2]) } : null;
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

/** Yahoo's roster slots folded into the planner's: PG and SG are guards, SF and PF forwards (#1022). */
const SLOT_FOLD: Record<string, 'G' | 'F' | 'C' | 'UTIL' | 'BN' | 'IL'> = {
  PG: 'G',
  SG: 'G',
  G: 'G',
  SF: 'F',
  PF: 'F',
  F: 'F',
  C: 'C',
  UTIL: 'UTIL',
  BN: 'BN',
  IL: 'IL',
  'IL+': 'IL',
  IR: 'IL',
  'IR+': 'IL',
  NA: 'IL',
};

/** The roster's shape from slot labels, each counted once per slot: the lineup, the bench and the IL. */
function shapeOf(labels: string[]): { lineup: { G: number; F: number; C: number; UTIL: number }; rosterSpots: number; ilSlots: number } | null {
  const count = { G: 0, F: 0, C: 0, UTIL: 0, BN: 0, IL: 0 };
  for (const l of labels) {
    const k = SLOT_FOLD[l.trim().toUpperCase()];
    if (k) count[k] += 1;
  }
  const active = count.G + count.F + count.C + count.UTIL;
  if (!active) return null;
  return { lineup: { G: count.G, F: count.F, C: count.C, UTIL: count.UTIL }, rosterSpots: active + count.BN, ilSlots: count.IL };
}

/** "Util (3)" or "Util x3" as three labels; "Util" as one. */
function expand(token: string): string[] {
  const m = token.trim().match(/^([A-Za-z+]+)\s*(?:\((\d+)\)|[x×]\s*(\d+))?$/);
  if (!m) return [];
  return Array.from({ length: Number(m[2] ?? m[3] ?? 1) }, () => m[1]!);
}

const rowValue = (rows: [string, string][], label: RegExp) => rows.find(([l]) => label.test(l))?.[1] ?? null;

/**
 * The league's roster and transaction rules from a version 4 bookmark (#1022): the lineup slots,
 * the roster spots (lineup plus bench) and the IL slots, from the settings page's roster positions,
 * else from the slots the Starting Rosters page shows (each team's Pos column, the most of each
 * label any team fills); the adds a week and the waiver days from the settings page.
 */
export function yahooRosterRules(
  rows: [string, string][],
  slotsByTeam: string[][],
): Partial<{ lineup: { G: number; F: number; C: number; UTIL: number }; rosterSpots: number; ilSlots: number; addsPerWeek: number | null; waiverDays: number | null }> {
  const out: ReturnType<typeof yahooRosterRules> = {};
  const positions = rowValue(rows, /^roster positions$/i);
  let shape = positions ? shapeOf(positions.split(',').flatMap(expand)) : null;
  if (!shape) {
    // the Pos column: a slot a team leaves empty has no player row, so take the most of each label
    const most = new Map<string, number>();
    for (const labels of slotsByTeam) {
      const n = new Map<string, number>();
      for (const l of labels) n.set(l.toUpperCase(), (n.get(l.toUpperCase()) ?? 0) + 1);
      for (const [l, c] of n) most.set(l, Math.max(most.get(l) ?? 0, c));
    }
    shape = shapeOf([...most].flatMap(([l, c]) => Array.from({ length: c }, () => l)));
  }
  if (shape) Object.assign(out, shape);
  const adds = rowValue(rows, /acquisitions per week|adds per week|weekly adds/i);
  if (adds !== null) {
    const n = adds.match(/\d+/);
    out.addsPerWeek = n ? Number(n[0]) : null; // "No maximum" and the like: no limit
  }
  const waiver = rowValue(rows, /^waiver time$/i);
  if (waiver !== null) {
    const n = waiver.match(/\d+/);
    out.waiverDays = n ? Number(n[0]) : /none|no waiver/i.test(waiver) ? 0 : null;
  }
  return out;
}

/** The league's trade and tie rules as Yahoo's settings page words them (#1025); each only when the page has it. */
export interface LeagueRules {
  tradeDeadline?: string;
  tradeReview?: string;
  tieBreaker?: string;
}

/** The trade deadline, how trades are reviewed and the playoff tie-breaker, from the settings page's rows (#1025). */
export function yahooLeagueRules(rows: [string, string][]): LeagueRules {
  const pick = (label: RegExp) => rows.find(([l]) => label.test(l))?.[1]?.trim().slice(0, 80);
  const out: LeagueRules = {};
  const deadline = pick(/^trade (end date|deadline)$/i);
  const review = pick(/^trade review$/i);
  const tie = pick(/tie-?breaker/i);
  if (deadline) out.tradeDeadline = deadline;
  if (review) out.tradeReview = review;
  if (tie) out.tieBreaker = tie;
  return out;
}
