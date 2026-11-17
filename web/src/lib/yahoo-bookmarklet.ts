/**
 * Importing a Yahoo league without Yahoo's Fantasy API, which is gated behind an approval the app
 * is still waiting on. A bookmarklet runs on the manager's own Yahoo league page, in their own
 * signed-in browser, reads each team's roster page the way the browser would, and hands the team
 * names and player names to the League page in the URL fragment (which never reaches a server).
 * The League page matches the names to players and fills the rosters.
 */
import { DEFAULT_SETTINGS, type LeagueSetup, type LeagueSource, matchNames, mondayOf, normalize } from './fantasy-league';
import { weekStart, yahooSource } from './league-sync';
import { easternDate } from './today';
import { cleanYahooPages, type YahooPages, yahooPlayoffs, yahooRecord, yahooRosterRules, yahooScore, yahooScoring } from './yahoo-pages';

interface YahooPlayer {
  name: string;
  /** On an injured-list slot (IL, IL+), which does not take a roster spot. */
  il: boolean;
  /** The row's roster slot as Yahoo labels it (PG, SG, G, SF, PF, F, C, UTIL, BN, IL...), when it has one (#1018). */
  slot?: string;
}

/** A player link the bookmark did not take, and why (#1018): nothing is dropped without saying so. */
export interface YahooRejected {
  name: string;
  reason: string;
}

/** The bookmark's version: an older one is asked to be added again (#1018). */
export const YAHOO_PAYLOAD_VERSION = 4;

interface YahooTeam {
  id: number;
  name: string;
  players: YahooPlayer[];
}

export interface YahooPayload extends YahooPages {
  v: 4;
  leagueId: string;
  /** Yahoo's id of the manager's team, where the page said which one that is. */
  mine: number | null;
  teams: YahooTeam[];
  /** The player links read and not taken, with the reason (#1018). */
  rejected: YahooRejected[];
}

/**
 * Whether a player link's text is a player's name (#1018). The link's address already says it is a
 * player's page, so only a link whose whole text is an action ("Add", "Drop", "Trade", "News"...)
 * is not a name. The words used to be matched anywhere in the text, which dropped Saddiq Bey (add).
 * Self-contained: the bookmarklet carries it as written, so it must not use anything else.
 */
export function rosterName(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 1 && t.length < 60 && /\p{L}/u.test(t) && !/^(add|drop|trade|notes?|news|compare|stats|watch(list)?)$/i.test(t);
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
function collectYahooLeague(target: string, isName: (text: string) => boolean): void {
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
  // every player link read and not taken, by name, with the reason (#1018)
  const rejected = new Map<string, string>();
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
    if (isName(n)) return n;
    if (n) rejected.set(n.slice(0, 60), 'its link text was not read as a name');
    return null;
  };
  type Row = { name: string; il: boolean; slot?: string };
  /** The players under `root`: rows with a slot label; every player link only when the page has no slots at all. */
  const rosterOf = (root: ParentNode) => {
    const links = Array.from(root.querySelectorAll('a[href*="/nba/players/"]'));
    const strict: Row[] = [];
    const loose: Row[] = [];
    for (const a of links) {
      const n = playerName(a);
      if (!n) continue;
      const slot = slotOf(a);
      if (!loose.some((p) => p.name === n)) loose.push({ name: n, il: !!slot && ilSlot.test(slot) });
      if (slot && !strict.some((p) => p.name === n)) strict.push({ name: n, il: ilSlot.test(slot), slot });
    }
    if (strict.length) {
      for (const p of loose) if (!strict.some((q) => q.name === p.name)) rejected.set(p.name, 'not in a roster row with a slot');
    }
    return strict.length ? strict : loose;
  };
  // Rosters on this page: climb from each team's heading to the smallest block that holds roster rows and no other team.
  const inPage = new Map<number, Row[]>();
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
      let players: Row[] = inPage.get(t) || [];
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
    const settings: { playoffs?: string; scoring?: string; rows?: [string, string][] } = {};
    const settingsPage = await read('settings');
    const rows: [string, string][] = [];
    for (const row of settingsPage ? Array.from(settingsPage.querySelectorAll('tr')) : []) {
      const c = cellsOf(row);
      if (/^playoffs:?$/i.test(c[0] || '') && c[1]) settings.playoffs = c[1];
      if (/^scoring type:?$/i.test(c[0] || '') && c[1]) settings.scoring = c[1];
      // every label and value, for the roster positions, the weekly adds and the waivers (#1018)
      if (c.length === 2 && c[0] && c[1] && c[0].length < 60 && rows.length < 80) rows.push([c[0].replace(/:$/, ''), c[1].slice(0, 200)]);
    }
    if (rows.length) settings.rows = rows;
    const taken = new Set(teams.flatMap((t) => t.players.map((p) => p.name)));
    // every player link on the page the bookmark ran on is accounted for (#1018)
    for (const a of Array.from(doc.querySelectorAll('a[href*="/nba/players/"]'))) {
      const n = playerName(a);
      if (n && !taken.has(n) && !rejected.has(n)) rejected.set(n, "not under any team's roster on the page");
    }
    const notTaken = Array.from(rejected, ([name, reason]) => ({ name, reason }))
      .filter((r) => !taken.has(r.name))
      .slice(0, 100);
    const payload: YahooPayload = { v: 4, leagueId, mine, teams, records, ...(matchup ? { matchup } : {}), settings, rejected: notTaken };
    location.href = target.replace(/#.*$/, '') + '#yahoo=' + encodeURIComponent(JSON.stringify(payload));
  })();
}

/** The bookmarklet: the collector above, serialised, aimed at the League page. */
export function yahooBookmarklet(target: string): string {
  return `javascript:(${collectYahooLeague.toString()})(${JSON.stringify(target)},${rosterName.toString()})`;
}

/** A player entry as a bookmark sent it. */
function yahooPlayer(x: unknown): YahooPlayer | null {
  if (!x || typeof x !== 'object' || !('name' in x)) return null;
  const p = x as { name: unknown; il?: unknown; slot?: unknown };
  const slot = typeof p.slot === 'string' && p.slot.length <= 6 ? p.slot.toUpperCase() : undefined;
  return { name: String(p.name), il: !!p.il, ...(slot ? { slot } : {}) };
}

/** The version a bookmark's payload says it is, or null when the fragment holds none (#1018). */
export function yahooHashVersion(hash: string): number | null {
  const m = hash.match(/^#yahoo=(.+)$/);
  if (!m || !m[1]) return null;
  try {
    const v = (JSON.parse(decodeURIComponent(m[1])) as { v?: unknown }).v;
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

/** What the League page says when the bookmark is older than the payload this page reads (#1018). */
export const YAHOO_OUTDATED =
  'This Yahoo bookmark is out of date, so nothing was imported. Add the bookmark again from this page (the steps are below), then run it on your Yahoo league.';

/** The payload a bookmarklet put in the URL fragment, or null when there is none or it is malformed. */
export function parseYahooHash(hash: string): YahooPayload | null {
  const m = hash.match(/^#yahoo=(.+)$/);
  if (!m || !m[1]) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(m[1])) as { v?: unknown; leagueId?: unknown; mine?: unknown; teams?: unknown; records?: unknown; matchup?: unknown; settings?: unknown; rejected?: unknown };
    // Only the current bookmark is read (#1018): an older one dropped players silently, and the
    // League page asks for it to be added again (yahooHashVersion, YAHOO_OUTDATED).
    if (raw.v !== YAHOO_PAYLOAD_VERSION || !Array.isArray(raw.teams) || !raw.teams.length) return null;
    const teams = (raw.teams as unknown[])
      .filter((t): t is { id: unknown; name?: unknown; players: unknown[] } => !!t && typeof t === 'object' && Array.isArray((t as { players?: unknown }).players))
      .map((t) => ({
        id: Number(t.id),
        name: String(t.name || `Team ${t.id}`).slice(0, 60),
        players: t.players.map(yahooPlayer).filter((p): p is YahooPlayer => !!p),
      }));
    const pages = cleanYahooPages(raw);
    const rejected = (Array.isArray(raw.rejected) ? raw.rejected : [])
      .filter((r): r is { name: unknown; reason: unknown } => !!r && typeof r === 'object' && 'name' in r)
      .map((r) => ({ name: String(r.name).slice(0, 60), reason: String(r.reason ?? '').slice(0, 80) }))
      .slice(0, 100);
    return teams.length
      ? { v: 4, leagueId: String(raw.leagueId ?? ''), mine: typeof raw.mine === 'number' ? raw.mine : null, teams, rejected, ...pages }
      : null;
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
  // the lineup, roster spots, IL slots, adds and waivers (#1022)
  Object.assign(settings, yahooRosterRules(payload.settings?.rows ?? [], payload.teams.map((t) => t.players.map((p) => p.slot ?? '').filter(Boolean))));
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
): { setup: LeagueSetup; matched: number; unmatched: string[]; il: number; rejected: YahooRejected[] } {
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
  // each player's slot as set on Yahoo when the bookmark ran (#1022), by player id
  const slots: Record<string, string> = {};
  for (const t of payload.teams) {
    for (const p of t.players) {
      const id = p.slot ? matchNames(p.name, players).matched[0] : undefined;
      if (id && p.slot) slots[id] = p.slot;
    }
  }
  const mine = Math.max(0, payload.teams.findIndex((t) => t.id === payload.mine));
  const state = yahooState(payload, mine, now);
  const next = normalize(
    { ...setup, ...state.settings, teams: payload.teams.length, names: payload.teams.map((t) => t.name), rosters, mine, il, picks: [], drafting: false },
    DEFAULT_SETTINGS['nba'],
  );
  return {
    setup: {
      ...next,
      source: {
        ...yahooSource(payload.leagueId, next.rosters, now, setup.source),
        ...state.source,
        ...(Object.keys(slots).length ? { slots } : {}),
        // the manager's roster at the week's first import, for the adds made since (#1022)
        week: weekStart(setup.source, payload.leagueId, mondayOf(easternDate(new Date(now))), next.rosters[next.mine] ?? []),
      },
    },
    matched,
    unmatched,
    il: next.il.length,
    rejected: payload.rejected,
  };
}
