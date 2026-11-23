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
import type { LeagueWeek } from './league-weeks';
import { cleanYahooPages, type YahooPages, yahooAddsUsed, yahooLeagueRules, yahooPlayoffs, yahooRecord, yahooRosterRules, yahooScore, yahooScoring, yahooWeeks } from './yahoo-pages';

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
 * The names of teams read from their own pages (#1047), one per page in order, '' where the page
 * does not say for certain (the team is then "Team N"). A page says its team's name in its team
 * element and its roster's caption ("Name's Players roster for <date>.", both in `said`), and in
 * its title, "League - Team | Fantasy Basketball | Yahoo! Sports": the title counts only in that
 * exact shape, with the league's name, known from the league home page's title ("League | Fantasy
 * Basketball | Yahoo! Sports"), taken off the front. The page's h1 is Yahoo's logo, never read.
 * Every source a page has must agree; a name longer than 60, or one another team has, is not
 * taken: a wrong name that looks right is worse than "Team N". Self-contained: the bookmarklet
 * carries it as written, so it must not use anything else.
 */
export function teamPageNames(homeTitle: string, pages: { title: string; said: string[] }[], others: string[]): string[] {
  const suffix = ' | Fantasy Basketball | Yahoo! Sports';
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const home = clean(homeTitle);
  const league = home.endsWith(suffix) ? home.slice(0, -suffix.length) : '';
  const names = pages.map((p) => {
    const title = clean(p.title);
    const fromTitle = league && title.endsWith(suffix) && title.startsWith(league + ' - ') ? title.slice(league.length + 3, -suffix.length) : '';
    const said = Array.from(new Set([...p.said, fromTitle].map(clean).filter(Boolean)));
    return said.length === 1 && said[0]!.length <= 60 ? said[0]! : ''; // def: the 60 characters a team name is kept to
  });
  return names.map((n) => (n && !others.includes(n) && names.indexOf(n) === names.lastIndexOf(n) ? n : ''));
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
function collectYahooLeague(target: string, isName: (text: string) => boolean, capture: boolean, pageNames: typeof teamPageNames): void {
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
  // the capture (#1030): every page the bookmark reads, as it read it, saved on the device at the end
  const pages: { url: string; status: number; html: string }[] = [{ url: location.href, status: 200, html: doc.documentElement.outerHTML }];
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
    // what each team page read for its roster says the team is called, settled below (#1047)
    const fromPages = new Map<number, { title: string; said: string[] }>();
    // Every Yahoo page the bookmark reads comes a second after the one before has answered, the
    // page it runs on included (#1062): the owner's reading rule.
    let answered = Date.now();
    const get = async (path: string) => {
      const wait = answered + 1000 - Date.now(); // def: a second between Yahoo's pages (the owner's reading rule)
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      try {
        const res = await fetch(base + path, { credentials: 'include' });
        const text = await res.text();
        if (capture) pages.push({ url: base + path, status: res.status, html: text });
        return { ok: res.ok, text };
      } finally {
        answered = Date.now();
      }
    };
    let misses = 0;
    // the team pages that did not answer with a roster (#1104), named at the end, never dropped
    const failed: number[] = [];
    for (const t of ids) {
      let players: Row[] = inPage.get(t) || [];
      const name = names.get(t) || '';
      if (!players.length) {
        try {
          const res = await get(String(t));
          if (res.ok) {
            const page = new DOMParser().parseFromString(res.text, 'text/html');
            players = rosterOf(page);
            // the team's element without its menu icon, and the roster's caption (#1047)
            if (!name) {
              const said = Array.from(page.querySelectorAll('.team-name')).map((el) => {
                const c = el.cloneNode(true) as Element;
                for (const icon of Array.from(c.querySelectorAll('.F-icon'))) icon.remove();
                return textOf(c);
              });
              for (const c of Array.from(page.querySelectorAll('caption'))) {
                const m = textOf(c).match(/^(.+?)['’]s? Players roster for \d{4}-\d\d-\d\d\.?$/);
                if (m && m[1]) said.push(m[1]);
              }
              fromPages.set(t, { title: page.title, said });
            }
            if (mine === null && Array.from(page.querySelectorAll('a[href]')).some((x) => /my team/i.test(x.textContent || '') && teamLink(x) === t)) mine = t;
          }
        } catch {
          players = [];
        }
      }
      if (!players.length) {
        misses += 1;
        failed.push(t);
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
        const res = await get(path);
        return res.ok ? new DOMParser().parseFromString(res.text, 'text/html') : null;
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
    // the names read from team pages, once the league's name is known from its home page (#1047)
    const named = teams.filter((x) => fromPages.has(x.id));
    const settled = pageNames(
      home ? home.title : '',
      named.map((x) => fromPages.get(x.id)!),
      teams.filter((x) => !fromPages.has(x.id)).map((x) => x.name),
    );
    named.forEach((x, i) => (x.name = settled[i] || 'Team ' + x.id));
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
    type Totals = { labels: string[]; rows: { id: number; cells: string[] }[] };
    /** A matchup page's totals table: its labels and both sides' rows; undefined when the page has none. */
    const totalsOf = (page: Document | null): Totals | undefined => {
      for (const table of page ? Array.from(page.querySelectorAll('table')) : []) {
        const head = headOf(table);
        const labels = head ? cellsOf(head) : [];
        if (!/^team$/i.test(labels[0] || '') || !labels.some((l) => /^(PTS|REB|AST)$/i.test(l))) continue;
        const rows = Array.from(table.querySelectorAll('tbody tr')).flatMap((row) => {
          const id = teamOf(row);
          return id === null ? [] : [{ id, cells: cellsOf(row) }];
        });
        // two sides; one in a playoff week where a team has a bye
        return rows.length === 2 || rows.length === 1 ? { labels, rows } : undefined;
      }
      return undefined;
    };
    const matchup = totalsOf(await read('matchup' + (mine !== null ? '?mid1=' + mine : '')));
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
    // The teams this import is missing (#1104). The league's size: its team links, the standings'
    // rows, or the settings' "Max Teams", the largest; without any, a team page that failed below
    // one that answered is still a team. Each is named, and the League page says the league is incomplete.
    const maxTeams = Number((rows.find((r) => /^max teams$/i.test(r[0])) || [])[1]) || 0;
    const of = Math.max(names.size, Object.keys(records).length, maxTeams) || 0;
    const got = new Set(teams.map((x) => x.id));
    const top = Math.max(...teams.map((x) => x.id));
    const asked = of ? Array.from(new Set([...Array.from({ length: of }, (_, i) => i + 1), ...names.keys()])) : failed.filter((id) => id < top);
    const missing = asked.filter((id) => !got.has(id)).map((id) => ({ id, ...(names.get(id) ? { name: names.get(id) } : {}) }));
    // the manager's team page says how many of the week's adds are used (#1028): the two numbers
    // only, never the page's text around them (#1061)
    let addsCount: [number, number] | undefined;
    const own = mine !== null ? await read(String(mine)) : null;
    const said = own ? ((own.body && own.body.textContent) || '').replace(/\s+/g, ' ').match(/used (\d{1,2}) of (?:your )?(\d{1,2}) player adds?/i) : null;
    if (said) addsCount = [Number(said[1]), Number(said[2])];
    // Every week's matchup totals (#1049). The home page's Matchups module links this week's
    // matchups (matchup?week=W&mid1=..&mid2=..): weeks 1 to W are read, one page at a time with a
    // pause between them, a page per matchup (each holds both sides). The first page that does not
    // answer stops the reading, and is named. Finished weeks are kept on this device, under the
    // league's id, and not asked for again; the current week is read on every run.
    let current = 0;
    for (const a of home ? Array.from(home.querySelectorAll('a[href]')) : []) {
      let u: URL;
      try {
        u = new URL(hrefOf(a), location.href);
      } catch {
        continue;
      }
      const w = Number(u.searchParams.get('week'));
      if (u.pathname === base + 'matchup' && u.searchParams.has('mid1') && Number.isInteger(w) && w > 0 && w <= 30) current = Math.max(current, w); // def: a season has fewer than thirty fantasy weeks
    }
    const store = 'fantasyscout:weeks:' + leagueId;
    type Week = { week: number; final: boolean; pages: Totals[]; at?: number; left?: number[]; confirmed?: boolean; blanks?: string; blankKept?: boolean };
    const weeks: Week[] = [];
    let weeksStop: { week: number; page: string; why?: 'not-shown' | 'not-matchup' | 'other-week' | 'no-totals'; shows?: number; noSettings?: boolean } | undefined;
    // the first playoff week, from the settings page's line "6 teams - Week 20, 21 and 22 (...)" (#1063)
    const playoffFrom = Number((/weeks?\s+(\d+)/i.exec(settings.playoffs || '') || [])[1]) || 0;
    // The week a page is Yahoo's matchup page for (#1063): every real one carries #matchup and
    // #matchupweek, whose address names the week (matchup_week=W); an error page has neither. 0 when not one.
    const weekOf = (page: Document | null) => {
      const marker = page && page.getElementById('matchup') ? page.getElementById('matchupweek') : null;
      const m = /[?&]matchup_week=(\d+)/.exec((marker && marker.getAttribute('data-href')) || '');
      return m ? Number(m[1]) : 0;
    };
    // the teams a finished playoff week's last read did not find, until a second read agrees (#1063)
    const unconfirmed = new Map<number, number[]>();
    // the blank totals a finished week's last read found (#1062), until a read from its Tuesday on finds the same
    const blanksBefore = new Map<number, string>();
    // no week is read without the home page's matchup links: say which, never nothing
    if (!current) weeksStop = { week: 0, page: home ? 'home-no-matchups' : 'home' };
    // Yahoo applies stat corrections through the Monday after a week (#1062): the last finished
    // week is read once more on a run from Tuesday 00:00 Eastern on, unless it was read since.
    const eastern = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const tuesday = Date.now() - ((((eastern.getDay() + 5) % 7) * 24 + eastern.getHours()) * 3600 + eastern.getMinutes() * 60 + eastern.getSeconds()) * 1000; // def: days back to Tuesday, hours, minutes and seconds in ms
    // whether a finished week's Tuesday has come: always for an older week, from Tuesday on for last week
    const pastTuesday = (w: number) => w < current - 1 || eastern.getDay() !== 1;
    // the totals with no digit (blank, "-", "-/-") in a labelled column (#1062), as "team:label", '' when none
    const blanksOf = (ps: Totals[]) =>
      ps
        .flatMap((p) => p.rows.flatMap((r) => r.cells.flatMap((c, i) => (i > 0 && p.labels[i] && !/\d/.test(c) ? [r.id + ':' + p.labels[i]] : []))))
        .sort()
        .join(',');
    if (current) {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(store) || '[]');
        for (const k of Array.isArray(saved) ? (saved as { week?: unknown; pages?: unknown; left?: unknown; confirmed?: unknown; at?: unknown; blanks?: unknown; blankKept?: unknown }[]) : []) {
          const pages = Array.isArray(k && k.pages) ? (k.pages as Totals[]).filter((p) => p && Array.isArray(p.labels) && Array.isArray(p.rows) && (p.rows.length === 2 || p.rows.length === 1)) : []; // the same pages a run reads: two sides, or one in a bye
          const left = k && Array.isArray(k.left) ? (k.left as unknown[]).filter((x): x is number => typeof x === 'number') : [];
          if (!k || typeof k.week !== 'number' || !Number.isInteger(k.week) || k.week <= 0 || k.week >= current || !pages.length || weeks.some((x) => x.week === k.week)) continue;
          const at = typeof k.at === 'number' ? k.at : 0;
          const blanks = typeof k.blanks === 'string' ? k.blanks : '';
          if (left.length) unconfirmed.set(k.week, left);
          if (blanks) blanksBefore.set(k.week, blanks);
          // read again: a week with teams not found until two reads after it agree; a week with a
          // blank total until it is kept; last week once from its Tuesday on, for stat corrections
          if (left.length && k.confirmed !== true) continue;
          if (blanks && k.blankKept !== true) continue;
          if (k.week === current - 1 && at < tuesday) continue;
          weeks.push({ week: k.week, final: true, pages, at, ...(left.length ? { left, confirmed: true } : {}), ...(blanks ? { blanks, blankKept: true } : {}) });
        }
      } catch {
        // storage blocked or unreadable: every week is read
      }
      for (let w = 1; w <= current && !weeksStop; w++) {
        if (w < current && weeks.some((x) => x.week === w)) continue;
        const covered = new Set<number>();
        const ofWeek: Totals[] = [];
        const left: number[] = [];
        for (const t of teams.map((x) => x.id)) {
          if (covered.has(t)) continue;
          const path = 'matchup?week=' + w + '&mid1=' + t;
          const page = await read(path);
          const totals = totalsOf(page);
          // The page must show the team asked for (#1063). In a playoff week, the team is set aside
          // only when the page is Yahoo's matchup page for this week and shows other teams' rows but
          // not this team's; what that means is not known (no such page has been seen yet), so the
          // League page says only what was seen. Anything else stops the reading and is named.
          const shown = !!totals && totals.rows.some((r) => r.id === t);
          const shows = weekOf(page);
          if (!shown && totals && playoffFrom && w >= playoffFrom && shows === w) {
            left.push(t);
            covered.add(t);
            continue;
          }
          // a page is kept under week W only when it says it shows week W (#1123); else the reading
          // stops, and the stop says what the page did: no answer, not a matchup page, another
          // week's, no category table, or a table without the team
          const why = !page ? null : !shows ? 'not-matchup' : shows !== w ? 'other-week' : !totals ? 'no-totals' : !shown ? 'not-shown' : '';
          if (why !== '' || !totals) {
            weeksStop = { week: w, page: path, ...(why ? { why } : {}), ...(why === 'other-week' ? { shows } : {}), ...(why === 'not-shown' && !settingsPage ? { noSettings: true } : {}) };
            break;
          }
          ofWeek.push(totals);
          covered.add(t);
          for (const r of totals.rows) covered.add(r.id);
        }
        // a week no page showed is not a week read: stop at its first page
        if (!weeksStop && !ofWeek.length) weeksStop = { week: w, page: 'matchup?week=' + w + '&mid1=' + (left[0] || 0), why: 'not-shown' };
        if (weeksStop) break;
        const final = w < current;
        // a team another page showed was not left out
        const out = left.filter((id) => !ofWeek.some((p) => p.rows.some((r) => r.id === id)));
        const before = unconfirmed.get(w);
        const agrees = !!before && before.length === out.length && out.every((id) => before.includes(id));
        // A finished week's blank totals (#1062): the week is read again until a read from its
        // Tuesday on finds the same blanks as the read before; then it is kept, the blanks named.
        const blanks = final ? blanksOf(ofWeek) : '';
        const blankKept = !!blanks && blanksBefore.get(w) === blanks && pastTuesday(w);
        weeks.push({ week: w, final, pages: ofWeek, at: Date.now(), ...(out.length ? { left: out, confirmed: final && agrees } : {}), ...(blanks ? { blanks, blankKept } : {}) });
      }
      weeks.sort((x, y) => x.week - y.week);
      try {
        localStorage.setItem(
          store,
          JSON.stringify(
            weeks
              .filter((x) => x.final)
              .map((x) => ({
                week: x.week,
                pages: x.pages,
                at: x.at || Date.now(),
                ...(x.left ? { left: x.left, confirmed: !!x.confirmed } : {}),
                ...(x.blanks ? { blanks: x.blanks, blankKept: !!x.blankKept } : {}),
              })),
          ),
        );
      } catch {
        // storage blocked: the next run reads every week again
      }
    }
    // the labels once when every page has the same, else on each page that differs
    const weekLabels = weeks.length ? weeks[0]!.pages[0]!.labels : [];
    const sameLabels = (l: string[]) => l.length === weekLabels.length && l.every((x, i) => x === weekLabels[i]);
    const weekPages = weeks.map((x) => ({ week: x.week, final: x.final, pages: x.pages.map((p) => (sameLabels(p.labels) ? { rows: p.rows } : p)), ...(x.left ? { left: x.left } : {}), ...(x.blankKept ? { blankKept: true } : {}) }));
    const taken = new Set(teams.flatMap((t) => t.players.map((p) => p.name)));
    // every player link on the page the bookmark ran on is accounted for (#1018)
    for (const a of Array.from(doc.querySelectorAll('a[href*="/nba/players/"]'))) {
      const n = playerName(a);
      if (n && !taken.has(n) && !rejected.has(n)) rejected.set(n, "not under any team's roster on the page");
    }
    const notTaken = Array.from(rejected, ([name, reason]) => ({ name, reason }))
      .filter((r) => !taken.has(r.name))
      .slice(0, 100);
    const payload: YahooPayload = {
      v: 4,
      leagueId,
      mine,
      teams,
      records,
      ...(matchup ? { matchup } : {}),
      settings,
      ...(addsCount ? { addsCount } : {}),
      ...(missing.length ? { incomplete: { missing, of: of || null } } : {}),
      ...(weeks.length ? { weekLabels, weeks: weekPages } : {}),
      ...(weeksStop ? { weeksStop } : {}),
      rejected: notTaken,
    };
    const go = () => {
      location.href = target.replace(/#.*$/, '') + '#yahoo=' + encodeURIComponent(JSON.stringify(payload));
    };
    if (!capture) return go();
    // one file on this device, from this page: nothing is uploaded, and the import goes on after
    const file = 'yahoo-pages-' + leagueId + '-' + new Date().toISOString().slice(0, 10) + '.json';
    const blob = new Blob([JSON.stringify({ capturedAt: new Date().toISOString(), leagueId, pages }, null, 1)], { type: 'application/json' });
    const link = doc.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = file;
    doc.body.appendChild(link);
    link.click();
    if (confirm('Saved the ' + pages.length + ' Yahoo pages the import read as ' + file + ' on this device. Go on to the import?')) go();
  })();
}

/**
 * The bookmarklet: the collector above, serialised, aimed at the League page. With `capture`, it
 * also saves the Yahoo pages it read as one file on the device before the import (#1030).
 */
export function yahooBookmarklet(target: string, capture = false): string {
  return `javascript:(${collectYahooLeague.toString()})(${JSON.stringify(target)},${rosterName.toString()},${capture},${teamPageNames.toString()})`;
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
    const raw = JSON.parse(decodeURIComponent(m[1])) as { v?: unknown; leagueId?: unknown; mine?: unknown; teams?: unknown; records?: unknown; matchup?: unknown; settings?: unknown; adds?: unknown; addsCount?: unknown; weekLabels?: unknown; weeks?: unknown; weeksStop?: unknown; rejected?: unknown; incomplete?: unknown };
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
  // the trade deadline, the trade review and the tie-breaker (#1025)
  const rules = yahooLeagueRules(payload.settings?.rows ?? []);
  if (Object.keys(rules).length) source.rules = rules;
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
 * The weeks an import holds (#1049): the weeks this payload carries, and the finished weeks an
 * earlier import of the same league had that this one does not. A week this payload carries
 * replaces the old one; a week that was still under way is not kept.
 */
function keptWeeks(previous: LeagueSource | undefined, leagueId: string, read: LeagueWeek[], homeFailed = false): LeagueWeek[] {
  const old = previous?.host === 'yahoo' && previous.leagueId === leagueId ? (previous.weeks ?? []) : [];
  // the home page failed, so no week was read: every week the last import had stays as it was
  if (homeFailed && !read.length) return [...old];
  return [...old.filter((w) => w.final && !read.some((r) => r.week === w.week)), ...read].sort((a, b) => a.week - b.week);
}

/** The name of the team the weeks' reading stopped at (#1063), from the page's mid1, where the payload has it. */
function stopTeam(payload: YahooPayload): { team?: string } {
  const id = Number(/mid1=(\d+)/.exec(payload.weeksStop?.page ?? '')?.[1]);
  const team = payload.teams.find((t) => t.id === id);
  return team ? { team: team.name } : {};
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
  // the numbers a bookmark sends (#1061); an older bookmark's sentence still reads
  const addsUsed = payload.addsCount ? { used: payload.addsCount[0], limit: payload.addsCount[1] } : payload.adds ? yahooAddsUsed(payload.adds) : null;
  const weeks = keptWeeks(setup.source, payload.leagueId, yahooWeeks(payload, payload.teams.map((t) => t.id)), payload.weeksStop?.week === 0);
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
        // Yahoo's own count of the week's adds at this import, with the roster it counted (#1028)
        ...(addsUsed ? { addsUsed: { monday: mondayOf(easternDate(new Date(now))), used: addsUsed.used, roster: [...(next.rosters[next.mine] ?? [])] } } : {}),
        // the teams this import is missing, so the league is never shown as whole (#1104)
        ...(payload.incomplete ? { incomplete: { ...payload.incomplete, read: payload.teams.length } } : {}),
        // every week's matchup totals, and the page this import stopped at (#1049)
        ...(weeks.length ? { weeks } : {}),
        // with the asked team's name, for the League page's line (#1063)
        ...(payload.weeksStop ? { weeksStop: { ...payload.weeksStop, ...stopTeam(payload) } } : {}),
      },
    },
    matched,
    unmatched,
    il: next.il.length,
    rejected: payload.rejected,
  };
}
