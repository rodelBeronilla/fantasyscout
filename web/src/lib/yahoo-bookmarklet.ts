/**
 * Importing a Yahoo league without Yahoo's Fantasy API, which is gated behind an approval the app
 * is still waiting on. A bookmarklet runs on the manager's own Yahoo league page, in their own
 * signed-in browser, reads each team's roster page the way the browser would, and hands the team
 * names and player names to the League page in the URL fragment (which never reaches a server).
 * The League page matches the names to players and fills the rosters.
 */
import { DEFAULT_SETTINGS, type LeagueSetup, matchNames, normalize } from './fantasy-league';

export interface YahooPlayer {
  name: string;
  /** On an injured-list slot (IL, IL+), which does not take a roster spot. */
  il: boolean;
}

export interface YahooTeam {
  id: number;
  name: string;
  players: YahooPlayer[];
}

export interface YahooPayload {
  v: 2;
  leagueId: string;
  /** Yahoo's id of the manager's team, where the page said which one that is. */
  mine: number | null;
  teams: YahooTeam[];
}

/**
 * Runs on a page inside a Yahoo fantasy basketball league. Self-contained: it is serialised into
 * the bookmarklet, so it must not use anything from this module.
 */
export function collectYahooLeague(target: string): void {
  const doc = document;
  const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  const hrefOf = (a: HTMLAnchorElement) => a.getAttribute('href') || '';
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
  const names = new Map<number, string>();
  let mine: number | null = null;
  for (const a of anchors) {
    const m = hrefOf(a).match(/\/nba\/(\d+)\/(\d+)\/?$/);
    if (!m || m[1] !== leagueId) continue;
    const t = Number(m[2]);
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (/my team/i.test(text)) {
      mine = t;
      continue;
    }
    if (text && text.length < 60 && !names.has(t)) names.set(t, text);
  }
  const ids = names.size ? Array.from(names.keys()).sort((x, y) => x - y) : Array.from({ length: 20 }, (_, i) => i + 1);
  const blocked = /note|news|compare|stats|watch|add|drop|trade/i;
  // The roster slot sits in the player's row as a short label; IL and IL+ are the injured list.
  const slot = /^(IL\+?|IR\+?|NA)$/i;
  const onIl = (a: Element) => {
    const row = a.closest('tr') || a.closest('li') || a.parentElement;
    if (!row) return false;
    return Array.from(row.querySelectorAll('td, th, span, div, abbr, button')).some((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length <= 4 && slot.test(t);
    });
  };
  const rosterOf = (page: Document) => {
    const out: { name: string; il: boolean }[] = [];
    for (const a of Array.from(page.querySelectorAll('a[href*="/nba/players/"]'))) {
      const n = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (n.length > 2 && n.length < 40 && /\s/.test(n) && !blocked.test(n) && !out.some((p) => p.name === n)) out.push({ name: n, il: onIl(a) });
    }
    return out;
  };
  (async () => {
    const teams: YahooTeam[] = [];
    let misses = 0;
    for (const t of ids) {
      let players: { name: string; il: boolean }[] = [];
      let name = names.get(t) || '';
      try {
        const res = await fetch(base + t, { credentials: 'include' });
        if (res.ok) {
          const page = new DOMParser().parseFromString(await res.text(), 'text/html');
          players = rosterOf(page);
          if (!name) name = ((page.querySelector('h1') || {}).textContent || page.title || 'Team ' + t).replace(/\s+/g, ' ').trim().slice(0, 60);
          if (mine === null && Array.from(page.querySelectorAll('a[href]')).some((a) => /my team/i.test(a.textContent || '') && new RegExp('/nba/' + leagueId + '/' + t + '/?$').test(a.getAttribute('href') || ''))) mine = t;
        }
      } catch {
        players = [];
      }
      if (!players.length) {
        misses += 1;
        if (!names.size && misses >= 2) break;
        continue;
      }
      teams.push({ id: t, name: name || 'Team ' + t, players });
    }
    if (!teams.length) {
      alert('No rosters were found on this league’s team pages. Open your league on Yahoo (the My Team or League tab) and run the bookmark again.');
      return;
    }
    const payload: YahooPayload = { v: 2, leagueId, mine, teams };
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
    const raw = JSON.parse(decodeURIComponent(m[1])) as { v?: unknown; leagueId?: unknown; mine?: unknown; teams?: unknown };
    // Version 1 bookmarks (names only) still work; version 2 says who is on the injured list.
    if ((raw.v !== 1 && raw.v !== 2) || !Array.isArray(raw.teams) || !raw.teams.length) return null;
    const teams = (raw.teams as unknown[])
      .filter((t): t is { id: unknown; name?: unknown; players: unknown[] } => !!t && typeof t === 'object' && Array.isArray((t as { players?: unknown }).players))
      .map((t) => ({
        id: Number(t.id),
        name: String(t.name || `Team ${t.id}`).slice(0, 60),
        players: t.players.map(yahooPlayer).filter((p): p is YahooPlayer => !!p),
      }));
    return teams.length ? { v: 2, leagueId: String(raw.leagueId ?? ''), mine: typeof raw.mine === 'number' ? raw.mine : null, teams } : null;
  } catch {
    return null;
  }
}

/** The league with the imported teams: names, rosters matched by name, the injured list, and the manager's team. */
export function applyYahooImport(
  setup: LeagueSetup,
  payload: YahooPayload,
  players: { player_id: string; full_name: string | null }[],
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
  const next = normalize(
    { ...setup, teams: payload.teams.length, names: payload.teams.map((t) => t.name), rosters, mine, il, picks: [], drafting: false },
    DEFAULT_SETTINGS['nba'],
  );
  return { setup: next, matched, unmatched, il: next.il.length };
}
