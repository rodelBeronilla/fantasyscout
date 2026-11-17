/**
 * Fixtures from the owner's own Yahoo pages, with nothing that names his league (#1030). The
 * capture bookmark saves the pages the import read as one file on his device; he puts it in the
 * repository's ignored `private/` folder, and `scripts/yahoo-fixtures.mjs` writes the fixtures from
 * it through these functions. Team names, manager names and the league id are replaced, and the
 * run fails if any original string is still anywhere in what it would write.
 */

interface CapturedPage {
  url: string;
  status: number;
  html: string;
}

export interface Capture {
  capturedAt: string;
  leagueId: string;
  pages: CapturedPage[];
}

/** The league id the fixtures use, as the hand-written ones do. */
export const FIXTURE_LEAGUE = '12345';

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    // last, so an escaped entity such as &amp;#39; stays as the page wrote it
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const hrefOf = (attrs: string) => attrs.match(/href\s*=\s*"([^"]*)"/i)?.[1] ?? '';

/**
 * The strings that name the league: each team's name (the text of a link to one of its team pages),
 * each manager's name (a link to a Yahoo profile, or an element whose class says manager), and any
 * extra strings listed by hand. "My Team" and the like are not names.
 */
export function namesIn(capture: Capture, extra: readonly string[] = []): { teams: string[]; managers: string[] } {
  const teams = new Set<string>();
  const managers = new Set<string>();
  const teamLink = new RegExp(`/nba/${capture.leagueId}/(\\d+)/?(?:[?#].*)?$`);
  for (const page of capture.pages) {
    for (const m of page.html.matchAll(ANCHOR)) {
      const attrs = m[1] ?? '';
      const text = textOf(m[2] ?? '');
      if (!text || text.length > 60) continue;
      const href = hrefOf(attrs);
      if (teamLink.test(href) && !/^(my team|team \d+)$/i.test(text)) teams.add(text);
      if (/profiles\.sports\.yahoo\.com|\/user\/|\/profile\//i.test(href)) managers.add(text);
    }
    for (const m of page.html.matchAll(/<(\w+)[^>]*class="[^"]*\bmanager[\w-]*\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const text = textOf(m[2] ?? '');
      if (text && text.length <= 40 && !/^manager$/i.test(text)) managers.add(text);
    }
  }
  for (const e of extra) if (e.trim()) managers.add(e.trim());
  for (const t of teams) managers.delete(t);
  return { teams: [...teams].sort(), managers: [...managers].sort() };
}

/** Every way a string may sit in a page: as written, HTML-escaped, with either apostrophe, URL-encoded. */
export function variants(name: string): string[] {
  const apostrophes = [name, name.replace(/’/g, "'"), name.replace(/'/g, '’')];
  const out = new Set<string>();
  for (const n of apostrophes) {
    out.add(n);
    const escaped = n.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    for (const q of ['&#39;', '&#x27;', '&apos;', "'"]) out.add(escaped.replace(/'/g, q));
    // inside a page's embedded JSON, an apostrophe, a curly one and an ampersand as escapes
    out.add(n.replace(/'/g, '\\u0027').replace(/’/g, '\\u2019').replace(/&/g, '\\u0026'));
    // encodeURIComponent leaves an apostrophe as it is; a form or a link may still escape it
    for (const enc of [encodeURIComponent(n), encodeURIComponent(n).replace(/'/g, '%27')]) {
      out.add(enc);
      out.add(enc.replace(/%20/g, '+'));
    }
  }
  return [...out].filter((v) => v.length > 1).sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The replacement for every original: Team A..., Manager 1..., and the fixtures' league id. */
export function replacements(names: { teams: string[]; managers: string[] }): [string, string][] {
  const out: [string, string][] = [];
  names.teams.forEach((t, i) => out.push([t, `Team ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ''}`]));
  names.managers.forEach((m, i) => out.push([m, `Manager ${i + 1}`]));
  return out;
}

/** A page with every original replaced; the league id goes wherever it is a whole number. */
export function scrub(html: string, leagueId: string, pairs: [string, string][]): string {
  let out = html;
  // the longest first, so a team name holding a manager's name goes whole
  const all = pairs.flatMap(([from, to]) => variants(from).map((v) => [v, to] as const)).sort((a, b) => b[0].length - a[0].length);
  // whole words only, so a manager called Scott leaves Scottie Barnes as he is
  for (const [from, to] of all) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{N}])`, 'giu'), to);
  return out.replace(new RegExp(`(?<![0-9])${escapeRe(leagueId)}(?![0-9])`, 'g'), FIXTURE_LEAGUE);
}

/** The originals still present anywhere in `texts`, case-insensitive: the run fails on any. */
export function leftovers(texts: readonly string[], leagueId: string, originals: readonly string[]): string[] {
  const found = new Set<string>();
  const id = new RegExp(`(?<![0-9])${escapeRe(leagueId)}(?![0-9])`);
  for (const t of texts) {
    if (id.test(t)) found.add('the league id');
    for (const o of originals) {
      if (variants(o).some((v) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, 'iu').test(t))) found.add(o);
    }
  }
  return [...found];
}

/** A fixture's file name from the page's address: home, matchup, settings, startingrosters, team-3... */
export function fixtureName(url: string, leagueId: string, taken: Set<string>): string {
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(new RegExp(`^/nba/${escapeRe(leagueId)}/?`), '');
  const [route = '', query = ''] = path.split('?');
  const base = !route ? 'home' : /^\d+$/.test(route) ? `team-${route}` : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page';
  const week = query.match(/week=(\d+)/)?.[1];
  let name = week ? `${base}-week-${week}` : base;
  for (let i = 2; taken.has(name); i += 1) name = `${week ? `${base}-week-${week}` : base}-${i}`;
  taken.add(name);
  return `${name}.html`;
}
