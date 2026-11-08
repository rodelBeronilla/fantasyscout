/**
 * Importing a Yahoo league without Yahoo's Fantasy API, which is gated behind an approval the app
 * is still waiting on. A bookmarklet runs on the manager's own Yahoo league page, in their own
 * signed-in browser, reads each team's roster page the way the browser would, and hands the team
 * names and player names to the League page in the URL fragment (which never reaches a server).
 * The League page matches the names to players and fills the rosters.
 */
import { DEFAULT_SETTINGS, type LeagueSetup, type LeagueSource, matchNames, normalize } from './fantasy-league';
import { yahooSource } from './league-sync';
import { cleanYahooPages, type YahooPages, yahooPlayoffs, yahooRecord, yahooScore, yahooScoring } from './yahoo-pages';

interface YahooPlayer {
  name: string;
  /** On an injured-list slot (IL, IL+), which does not take a roster spot. */
  il: boolean;
}

interface YahooTeam {
  id: number;
  name: string;
  players: YahooPlayer[];
}

export interface YahooPayload extends YahooPages {
  v: 3;
  leagueId: string;
  /** Yahoo's id of the manager's team, where the page said which one that is. */
  mine: number | null;
  teams: YahooTeam[];
}

/**
 * Runs on a page inside a Yahoo fantasy basketball league. Self-contained: it is serialised into
 * the bookmarklet, so it must not use anything from this module.
 *
 * A page that lists every roster (the league's Starting Rosters page) is read where it is: each
 * team's players sit under a heading that links the team. Otherwise each team's page is fetched.
 * Either way a player counts only when the row has a roster slot label (PG, SG, G, SF, PF, F, C,
 * Util, BN, IL...): player links elsewhere on a page (news, research, suggested pickups) are not
 * the roster (#515).
 */
function collectYahooLeague(target: string): void {
  const doc = document;
  const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  const hrefOf = (a: Element) => a.getAttribute('href') || '';
  const textOf = (el: Element | null) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const fromPath = location.pathname.match(/\/nba\/(\d+)(?:\/|$)/);
  let leagueId = fromPath ? fromPath[1] : null;
  if (!leagueId) {
    for (const a of anchors) {
      const m = hrefOf(a).match(/\/nba\/(\d+)\/\d+\/?$/);
      if (m) {
        leagueId = m[1] ?? null;
        break;
      }
    }
  }
  if (!leagueId) {
    alert(
      'This bookmark ran on a page that is not your Yahoo league. Open your league on the Yahoo website, then run the bookmark on that page: ' +
        'on a phone, tap the address bar, type the bookmark’s name and tap it in the list (opening it from the Bookmarks menu runs it in a new tab).',
    );
    return;
  }
  const base = '/nba/' + leagueId + '/';
  const teamLink = (a: Element) => {
    const m = hrefOf(a).match(/\/nba\/(\d+)\/(\d+)\/?$/);
    return m && m[1] === leagueId ? Number(m[2]) : null;
  };
  const names = new Map<number, string>();
  let mine: number | null = null;
  for (const a of anchors) {
    const t = teamLink(a);
    if (t === null) continue;
    const text = textOf(a);
    if (/my team/i.test(text)) {
      mine = t;
      continue;
    }
    if (text && text.length < 60 && !names.has(t)) names.set(t, text);
  }
  const ids = names.size ? Array.from(names.keys()).sort((x, y) => x - y) : Array.from({ length: 20 }, (_, i) => i + 1);
  const blocked = /note|news|compare|stats|watch|add|drop|trade/i;
  // A roster row carries its slot as a short label; IL, IL+, IR and NA are the injured list.
  const slotText = /^(PG|SG|G|SF|PF|F|C|UTIL|BN|IL\+?|IR\+?|NA)$/i;
  const ilSlot = /^(IL|IR|NA)/i;
  const slotOf = (a: Element) => {
    const row = a.closest('tr') || a.closest('li');
    if (!row) return null;
    for (const el of Array.from(row.querySelectorAll('td, th, span, div, abbr, button'))) {
      const t = textOf(el);
      if (t.length <= 4 && slotText.test(t)) return t.toUpperCase();
    }
    return null;
  };
  const playerName = (a: Element) => {
    if (!/\/nba\/players\/\d+\/?$/.test(hrefOf(a))) return null;
    const n = textOf(a);
    return n.length > 2 && n.length < 40 && /\s/.test(n) && !blocked.test(n) ? n : null;
  };
  /** The players under `root`: rows with a slot label; every player link only when the page has no slots at all. */
  const rosterOf = (root: ParentNode) => {
    const links = Array.from(root.querySelectorAll('a[href*="/nba/players/"]'));
    const strict: { name: string; il: boolean }[] = [];
    const loose: { name: string; il: boolean }[] = [];
    for (const a of links) {
      const n = playerName(a);
      if (!n) continue;
      const slot = slotOf(a);
      if (!loose.some((p) => p.name === n)) loose.push({ name: n, il: !!slot && ilSlot.test(slot) });
      if (slot && !strict.some((p) => p.name === n)) strict.push({ name: n, il: ilSlot.test(slot) });
    }
    return strict.length ? strict : loose;
  };
  // Rosters on this page: climb from each team's heading to the smallest block that holds roster rows and no other team.
  const inPage = new Map<number, { name: string; il: boolean }[]>();
  for (const a of anchors) {
    const t = teamLink(a);
    if (t === null || inPage.has(t) || !names.has(t) || /my team/i.test(textOf(a))) continue;
    let el: Element | null = a.parentElement;
    while (el && el !== doc.body) {
      const others = Array.from(el.querySelectorAll('a[href]')).some((x) => {
        const o = teamLink(x);
        return o !== null && o !== t && !!textOf(x) && !/my team/i.test(textOf(x));
      });
      if (others) break;
      const roster = rosterOf(el);
      if (roster.length >= 3) {
        inPage.set(t, roster);
        break;
      }
      el = el.parentElement;
    }
  }
  (async () => {
    const teams: YahooTeam[] = [];
    let misses = 0;
    for (const t of ids) {
      let players: { name: string; il: boolean }[] = inPage.get(t) || [];
      let name = names.get(t) || '';
      if (!players.length) {
        try {
          const res = await fetch(base + t, { credentials: 'include' });
          if (res.ok) {
            const page = new DOMParser().parseFromString(await res.text(), 'text/html');
            players = rosterOf(page);
            if (!name) name = ((page.querySelector('h1') || {}).textContent || page.title || 'Team ' + t).replace(/\s+/g, ' ').trim().slice(0, 60);
            if (mine === null && Array.from(page.querySelectorAll('a[href]')).some((x) => /my team/i.test(x.textContent || '') && teamLink(x) === t)) mine = t;
          }
        } catch {
          players = [];
        }
      }
      if (!players.length) {
        misses += 1;
        if (!names.size && misses >= 2) break;
        continue;
      }
      teams.push({ id: t, name: name || 'Team ' + t, players });
    }
    if (!teams.length) {
      alert('No rosters were found. Open your league’s Starting Rosters page on Yahoo (League, then Starting Rosters) and run the bookmark there.');
      return;
    }
    // The league's state (#874): the standings on its home page, this week's matchup and the
    // settings. Each page's text goes as it stands; a page that does not answer is left out.
    const read = async (path: string) => {
      try {
        const res = await fetch(base + path, { credentials: 'include' });
        return res.ok ? new DOMParser().parseFromString(await res.text(), 'text/html') : null;
      } catch {
        return null;
      }
    };
    const cellsOf = (row: Element) => Array.from(row.children).map((c) => textOf(c));
    const teamOf = (row: Element) => {
      for (const a of Array.from(row.querySelectorAll('a[href]'))) {
        const t = teamLink(a);
        if (t !== null) return t;
      }
      return null;
    };
    const headOf = (table: Element) => table.querySelector('thead tr') || table.querySelector('tr');
    const records: Record<string, [string, string]> = {};
    const home = await read('');
    for (const table of home ? Array.from(home.querySelectorAll('table')) : []) {
      const head = headOf(table);
      const at = head ? cellsOf(head).findIndex((c) => /^W-L-T$/i.test(c)) : -1;
      if (at < 0) continue;
      for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
        const t = teamOf(row);
        const c = cellsOf(row);
        if (t !== null && c[at]) records[t] = [c[at] || '', c[0] || ''];
      }
      break;
    }
    let matchup: { labels: string[]; rows: { id: number; cells: string[] }[] } | undefined;
    const board = await read('matchup' + (mine !== null ? '?mid1=' + mine : ''));
    for (const table of board ? Array.from(board.querySelectorAll('table')) : []) {
      const head = headOf(table);
      const labels = head ? cellsOf(head) : [];
      if (!/^team$/i.test(labels[0] || '') || !labels.some((l) => /^(PTS|REB|AST)$/i.test(l))) continue;
      const rows = Array.from(table.querySelectorAll('tbody tr')).flatMap((row) => {
        const id = teamOf(row);
        return id === null ? [] : [{ id, cells: cellsOf(row) }];
      });
      if (rows.length === 2) matchup = { labels, rows };
      break;
    }
    const settings: { playoffs?: string; scoring?: string } = {};
    const settingsPage = await read('settings');
    for (const row of settingsPage ? Array.from(settingsPage.querySelectorAll('tr')) : []) {
      const c = cellsOf(row);
      if (/^playoffs:?$/i.test(c[0] || '') && c[1]) settings.playoffs = c[1];
      if (/^scoring type:?$/i.test(c[0] || '') && c[1]) settings.scoring = c[1];
    }
    const payload: YahooPayload = { v: 3, leagueId, mine, teams, records, ...(matchup ? { matchup } : {}), settings };
    location.href = target.replace(/#.*$/, '') + '#yahoo=' + encodeURIComponent(JSON.stringify(payload));
  })();
}

/** The bookmarklet: the collector above, serialised, aimed at the League page. */
export function yahooBookmarklet(target: string): string {
  return `javascript:(${collectYahooLeague.toString()})(${JSON.stringify(target)})`;
}

/** A player entry as a bookmark sent it: a version 1 bookmark sends the name alone. */
function yahooPlayer(x: unknown): YahooPlayer | null {
  if (typeof x === 'string') return { name: x, il: false };
  if (!x || typeof x !== 'object' || !('name' in x)) return null;
  const p = x as { name: unknown; il?: unknown };
  return { name: String(p.name), il: !!p.il };
}

/** The payload a bookmarklet put in the URL fragment, or null when there is none or it is malformed. */
export function parseYahooHash(hash: string): YahooPayload | null {
  const m = hash.match(/^#yahoo=(.+)$/);
  if (!m || !m[1]) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(m[1])) as { v?: unknown; leagueId?: unknown; mine?: unknown; teams?: unknown; records?: unknown; matchup?: unknown; settings?: unknown };
    // Version 1 bookmarks (names only) still work; version 2 says who is on the injured list;
    // version 3 adds the standings, this week's matchup and the settings (#874).
    if ((raw.v !== 1 && raw.v !== 2 && raw.v !== 3) || !Array.isArray(raw.teams) || !raw.teams.length) return null;
    const teams = (raw.teams as unknown[])
      .filter((t): t is { id: unknown; name?: unknown; players: unknown[] } => !!t && typeof t === 'object' && Array.isArray((t as { players?: unknown }).players))
      .map((t) => ({
        id: Number(t.id),
        name: String(t.name || `Team ${t.id}`).slice(0, 60),
        players: t.players.map(yahooPlayer).filter((p): p is YahooPlayer => !!p),
      }));
    const pages = raw.v === 3 ? cleanYahooPages(raw) : {};
    return teams.length ? { v: 3, leagueId: String(raw.leagueId ?? ''), mine: typeof raw.mine === 'number' ? raw.mine : null, teams, ...pages } : null;
  } catch {
    return null;
  }
}

/**
 * What the extra pages give the league (#874): each team's record and place, this week's opponent
 * and the score so far on both sides, the playoffs and how the records count. Team indexes follow
 * the payload's teams.
 */
function yahooState(payload: YahooPayload, mine: number, now: number): { source: Partial<LeagueSource>; settings: Partial<LeagueSetup> } {
  const index = (id: number) => payload.teams.findIndex((t) => t.id === id);
  const source: Partial<LeagueSource> = {};
  const settings: Partial<LeagueSetup> = {};
  if (payload.records) {
    const records = payload.teams.map((t) => {
      const r = payload.records?.[String(t.id)];
      return r ? yahooRecord(r[0], r[1]) : null;
    });
    if (records.some(Boolean)) source.records = records;
  }
  const sides = payload.matchup?.rows.map((r) => index(r.id)) ?? [];
  const other = sides[0] === mine ? sides[1] : sides[1] === mine ? sides[0] : undefined;
  if (payload.matchup && typeof other === 'number' && other >= 0) {
    const { labels, rows } = payload.matchup;
    source.opponents = payload.teams.map((_, i) => (i === mine ? other : i === other ? mine : null));
    source.scores = payload.teams.map((_, i) => {
      const row = rows.find((r) => index(r.id) === i);
      return row ? yahooScore(labels, row.cells) : null;
    });
    settings.opponent = other;
  }
  const playoffs = payload.settings?.playoffs ? yahooPlayoffs(payload.settings.playoffs, now) : null;
  if (playoffs) {
    source.playoffWeeks = { periods: playoffs.periods, from: playoffs.from, to: playoffs.to };
    settings.playoffs = { teams: playoffs.teams, weeks: playoffs.weeks, start: playoffs.from };
  }
  const scoring = payload.settings?.scoring ? yahooScoring(payload.settings.scoring) : null;
  if (scoring) {
    source.tally = scoring.tally;
    settings.format = scoring.format;
  }
  return { source, settings };
}

/**
 * The league with the imported teams: names, rosters matched by name, the injured list, the
 * manager's team, and when the bookmarklet ran (#815); with a version 3 bookmark, the standings,
 * this week's matchup and the playoffs too (#874).
 */
export function applyYahooImport(
  setup: LeagueSetup,
  payload: YahooPayload,
  players: { player_id: string; full_name: string | null }[],
  now = Date.now(),
): { setup: LeagueSetup; matched: number; unmatched: string[]; il: number } {
  const unmatched: string[] = [];
  const il: string[] = [];
  let matched = 0;
  const rosters = payload.teams.map((t) => {
    const result = matchNames(t.players.map((p) => p.name).join('\n'), players);
    matched += result.matched.length;
    unmatched.push(...result.unmatched);
    il.push(...matchNames(t.players.filter((p) => p.il).map((p) => p.name).join('\n'), players).matched);
    return result.matched;
  });
  const mine = Math.max(0, payload.teams.findIndex((t) => t.id === payload.mine));
  const state = yahooState(payload, mine, now);
  const next = normalize(
    { ...setup, ...state.settings, teams: payload.teams.length, names: payload.teams.map((t) => t.name), rosters, mine, il, picks: [], drafting: false },
    DEFAULT_SETTINGS['nba'],
  );
  return { setup: { ...next, source: { ...yahooSource(payload.leagueId, next.rosters, now), ...state.source } }, matched, unmatched, il: next.il.length };
}
