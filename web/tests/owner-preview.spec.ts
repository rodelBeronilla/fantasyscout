/**
 * The owner preview (#1056): the calls a switch hides show to the signed-in owner alone, with his
 * preview on, each under "Preview: not validated", and each only once the log holds it. The bar:
 * for everyone else, and for the owner with the preview off, the page is the same, byte for byte.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';

import { callKey, keysIn, planBatch, validEvent } from '../../worker/src/owner-log-event';
import { expect as baseExpect, test } from './fixtures';

type Row = { player_id: string };

// a frame shows its calls once the log holds them: they settle for two seconds, then go in one request
const expect = baseExpect.configure({ timeout: 15_000 });
const LOGGED = { timeout: 15_000 };

// the fixture's NBA data is as of 2026-10-31; a Monday two days later, mid-afternoon Eastern
const NOW = new Date('2026-11-02T16:00:00Z');

interface Seed {
  /** Yahoo's own count of the adds used this week, from an import this week; null for none. */
  addsUsed?: number | null;
  /** Whether the import read Yahoo's settings page (the adds a week and the waiver wait). */
  settingsRead?: boolean;
  /** On a copy whose settings were not read: whether he typed 4 adds and 2 days on the League page. */
  typed?: boolean;
  /** Whether there was an import this week, whose roster the adds since are counted from. */
  week?: boolean;
}

/** A made-up eight-team Yahoo head-to-head league, as the import keeps it, ten players a team. */
async function seedLeague(page: Page, { addsUsed = null, settingsRead = true, typed = false, week = true }: Seed = {}): Promise<{ rosters: string[][] }> {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as Row[];
  const teams = 8;
  const rosters = Array.from({ length: teams }, (_, t) => Array.from({ length: 10 }, (_, k) => board[t + teams * k]!.player_id));
  const copy = {
    version: 10,
    teams,
    rosterSpots: 13,
    scoring: 'cats9',
    format: 'h2h',
    punts: [],
    names: ['Harbor', 'Summit', 'Prairie', 'Canyon', 'Delta', 'Ridge', 'Meadow', 'Coast'],
    rosters,
    mine: 0,
    il: [],
    drafting: false,
    picks: [],
    opponent: 1,
    lineup: { G: 3, F: 3, C: 1, UTIL: 3 },
    ilSlots: 2,
    addsPerWeek: 4,
    waiverDays: 2,
    source: {
      host: 'yahoo',
      leagueId: '99',
      syncedAt: NOW.getTime() - 3_600_000,
      rosters,
      changes: null,
      opponents: [1, 0, 3, 2, 5, 4, 7, 6],
      // one of the manager's players was added since the week's first import: three adds left
      ...(week ? { week: { monday: '2026-11-02', roster: rosters[0]!.slice(1) } } : {}),
      // or Yahoo's own count of the adds used this week
      ...(addsUsed === null ? {} : { addsUsed: { monday: '2026-11-02', used: addsUsed, roster: rosters[0]! } }),
      // the rules the bookmark reads from Yahoo's settings page: their presence says the adds and the waiver wait were read
      ...(settingsRead ? { rules: { tradeReview: 'League Votes' } } : {}),
    },
    // an old copy holds neither setting, unless he typed them on the League page
    ...(settingsRead || typed ? {} : { addsPerWeek: null, waiverDays: null }),
  };
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((stored) => localStorage.setItem('fantasyscout:league:nba', stored), JSON.stringify(copy));
  return { rosters };
}

interface Who {
  /** The preview switch in this browser's storage. */
  switchOn: boolean;
  /** The flag a past owner sign-in leaves in this browser. */
  flag: boolean;
  /** What the Worker says of the owner cookie: true, false, or no Worker at all. */
  owner: boolean | 'no-worker';
}

const SIGNED_OUT: Who = { switchOn: false, flag: false, owner: false };
const OTHERS: [string, Who][] = [
  ['the switch on, the Worker saying not the owner', { switchOn: true, flag: true, owner: false }],
  ['the switch on, no Worker', { switchOn: true, flag: true, owner: 'no-worker' }],
  ['the owner, the switch off', { switchOn: false, flag: true, owner: true }],
];

/**
 * The owner's log as the Worker keeps it, by the Worker's own rule (worker/src/owner-log-event.ts):
 * a batch is answered call by call, each call kept once by its key, and anything the Worker would
 * refuse is refused here too. One log may serve several pages: two tabs, or two views.
 */
class Log {
  /** The calls stored, as the Worker stores them. */
  readonly posted: Record<string, unknown>[] = [];
  /** The calls, or whole events, the Worker's rule refused. */
  readonly refused: unknown[] = [];
  /** Each batch request, as it arrived. */
  readonly batches: { calls: Record<string, unknown>[] }[] = [];
  /** How a batch is answered: as the Worker would, or a failure. */
  answer: 'worker' | 400 | 500 | 503 | 'abort' = 'worker';
  /** How long the answer takes, in ms. */
  delay = 0;

  async handle(r: Route): Promise<void> {
    if (r.request().method() !== 'POST') return r.fulfill({ json: { ok: true } });
    const body: unknown = r.request().postDataJSON();
    if ((body as { kind?: unknown } | null)?.kind !== 'calls') {
      // a page or import event, by the Worker's rule for one event
      if (validEvent(body) === null) {
        this.refused.push(body);
        return r.fulfill({ status: 400, json: { error: 'not an event' } });
      }
      return r.fulfill({ json: { logged: true } });
    }
    this.batches.push(body as { calls: Record<string, unknown>[] });
    if (this.answer !== 'worker') {
      if (this.delay) await new Promise((done) => setTimeout(done, this.delay));
      return this.answer === 'abort' ? r.abort() : r.fulfill({ status: this.answer, json: { error: 'no' } });
    }
    // stored as it arrives, as the Worker stores it however long its answer takes to come back
    const plan = planBatch(body, keysIn(this.posted.map((c) => JSON.stringify(c)).join('\n')));
    if (!plan) {
      this.refused.push(body);
      return r.fulfill({ status: 400, json: { error: 'not a batch' } });
    }
    this.posted.push(...plan.write);
    (body as { calls: unknown[] }).calls.forEach((c, i) => plan.results[i] === 'refused' && this.refused.push(c));
    if (this.delay) await new Promise((done) => setTimeout(done, this.delay));
    return r.fulfill({ json: { results: plan.results } }).catch(() => undefined);
  }
}

/** Sets who this browser is, for the next page load, with the owner's log answered by `log`. */
async function as(page: Page, who: Who, log: Log = new Log()): Promise<void> {
  await page.evaluate((w) => {
    localStorage.removeItem('fantasyscout:owner-preview');
    localStorage.removeItem('fantasyscout:owner');
    if (w.switchOn) localStorage.setItem('fantasyscout:owner-preview', 'on');
    if (w.flag) localStorage.setItem('fantasyscout:owner', '1');
  }, who);
  await page.unroute('**/api/owner/**');
  if (who.owner === 'no-worker') {
    await page.route('**/api/owner/**', (r) => r.abort());
    return;
  }
  const owner = who.owner;
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner } }));
  await page.route('**/api/owner/log', (r) => log.handle(r));
}

/** The page's main content once it has settled. */
async function mainHtml(page: Page, path: string, ready: string): Promise<string> {
  await page.goto(path);
  await expect(page.getByTestId(ready).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  return page.locator('main').innerHTML();
}

const PAGES: { name: string; path: (rosters: string[][]) => string; ready: string; calls: Record<string, string> }[] = [
  {
    name: 'My Team',
    path: () => '/team/?league=nba',
    ready: 'my-roster',
    calls: { 'too-close': 'matchup', stream: 'matchup-streams', lineup: 'lineup-plan', swaps: 'upgrades', build: 'build-plan' },
  },
  { name: 'Pickups', path: () => '/streamers/?league=nba', ready: 'explore', calls: { 'top-adds': 'top-adds' } },
  {
    name: 'Trade',
    // one of the manager's bench players for the second team's best
    path: (rosters) => `/trade/?league=nba&give=${rosters[0]![9]}&get=${rosters[1]![0]}`,
    ready: 'trade-scorecard',
    // the finder's frame holds its button until asked: its call is logged once it has run
    calls: { 'trade-verdict': 'trade-scorecard', 'trade-suggestions': 'trade-suggestions-card', finder: 'find-trades' },
  },
];

for (const p of PAGES) {
  test(`${p.name}: signed out, and for anyone but the owner with his preview on, the page is the same byte for byte (#1056)`, async ({ page }) => {
    const { rosters } = await seedLeague(page);
    const path = p.path(rosters);
    await page.goto('/sources/');
    const asked: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/owner/')) asked.push(r.url());
    });
    await as(page, SIGNED_OUT);
    const baseline = await mainHtml(page, path, p.ready);
    // a signed-out browser asks nothing of the owner's routes
    expect(asked).toEqual([]);
    expect(baseline).not.toContain('Preview: not validated');
    for (const [label, who] of OTHERS) {
      await as(page, who);
      expect(await mainHtml(page, path, p.ready), label).toBe(baseline);
    }
  });

  test(`${p.name}: the owner with his preview on sees each hidden call in its frame, each logged once (#1056)`, async ({ page }) => {
    const { rosters } = await seedLeague(page);
    const log = new Log();
    const { posted, refused } = log;
    await page.goto('/sources/');
    await as(page, { switchOn: true, flag: true, owner: true }, log);
    await page.goto(p.path(rosters));
    const frames = page.getByTestId('owner-preview');
    for (const [call, inside] of Object.entries(p.calls)) {
      const frame = frames.and(page.locator(`[data-call="${call}"]`));
      await expect(frame, call).toBeVisible();
      await expect(frame.getByRole('heading', { name: /^Preview: not validated/ }), call).toBeVisible();
      await expect(frame, call).toContainText('Shown to you alone. This call has not passed its check (see Methodology); each one shown is logged.');
      // the hidden call itself, as its switch would show it
      await expect(inside === 'trade-suggestions-card' ? frame.locator('#suggestions') : frame.getByTestId(inside), call).toBeVisible();
      // a pickup is offered within the week's adds, and the waiver wait is said
      if (['stream', 'swaps', 'top-adds'].includes(call)) {
        await expect(frame.getByTestId('preview-adds-limit'), call).toContainText('3 of 4 adds left this week');
        await expect(frame.getByTestId('preview-adds-limit'), call).toContainText('A player dropped in the last 2 days is on waivers and cannot be added yet.');
      }
    }
    // the page's calls went to the log in one request
    expect(log.batches).toHaveLength(1);
    // the finder runs when asked, and its trades are logged then, in a request of their own
    if ('finder' in p.calls) {
      await frames.and(page.locator('[data-call="finder"]')).getByTestId('find-trades').click();
      await expect(page.locator('[data-call="trade-finder"]').getByTestId('found-trades')).toBeVisible();
      expect(log.batches).toHaveLength(2);
    }
    await page.waitForLoadState('networkidle');
    // every frame on the page, the ones the data allows (sell high, the punt's chips) included, logged
    // once it has settled: one entry for each call it shows (a list's trades, adds or players each their own)
    const shown = await frames.evaluateAll((els) => els.map((e) => e.getAttribute('data-call')));
    const logged = () => posted.filter((e) => e['kind'] === 'call').map((e) => e['call'] as string);
    await expect.poll(() => [...new Set(logged())].sort(), LOGGED).toEqual([...new Set(shown)].sort());
    await page.waitForLoadState('networkidle');
    // the Worker would store every one of them: nothing an eight-team league's frames post is refused
    expect(refused).toEqual([]);
    await expect(page.getByTestId('preview-not-logged')).toHaveCount(0);
    // a call that is one call is one entry; each entry is a different call
    for (const call of ['too-close', 'stream', 'lineup', 'trade-verdict']) if (call in p.calls) expect(logged().filter((c) => c === call), call).toHaveLength(1);
    const calls = posted.filter((e) => e['kind'] === 'call');
    expect(new Set(calls.map((e) => callKey(e))).size).toBe(calls.length);
    for (const e of calls) {
      expect(Object.keys(e).sort()).toEqual(['build', 'call', 'date', 'kind', 'league', 'naive', 'subject', 'value']);
      expect(e).toMatchObject({ date: '2026-11-02', subject: expect.any(String), value: expect.any(String), build: 'fixture', league: 'yahoo:99:1793631600000' });
      expect(e['naive'] === null || typeof e['naive'] === 'string').toBe(true);
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      const found = await new AxeBuilder({ page }).include('[data-testid="owner-preview"]').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(found.violations, theme).toEqual([]);
    }
  });
}

test('with no adds left this week, the preview offers no pickup and says so; with one left, one (#1056)', async ({ page }) => {
  await seedLeague(page, { addsUsed: 4 });
  await page.goto('/sources/');
  await as(page, { switchOn: true, flag: true, owner: true });
  for (const path of ['/streamers/?league=nba', '/team/?league=nba']) {
    await page.goto(path);
    const frames = page.getByTestId('owner-preview').filter({ has: page.getByTestId('preview-adds-limit') });
    await expect(frames.first(), path).toBeVisible();
    for (const frame of await frames.all()) {
      await expect(frame.getByTestId('preview-adds-limit')).toContainText("0 of 4 adds left this week: 4 used: 4 by Yahoo's count at your last import.");
      await expect(frame.getByTestId('top-add')).toHaveCount(0);
      await expect(frame.getByTestId('matchup-stream-move')).toHaveCount(0);
      await expect(frame.getByTestId('upgrades')).toHaveCount(0);
    }
  }
  await seedLeague(page, { addsUsed: 3 });
  await page.goto('/streamers/?league=nba');
  const frame = page.getByTestId('owner-preview').and(page.locator('[data-call="top-adds"]'));
  await expect(frame.getByTestId('preview-adds-limit')).toContainText("1 of 4 adds left this week: 3 used: 3 by Yahoo's count at your last import. No more than 1 is offered.");
  await expect(frame.getByTestId('top-add')).toHaveCount(1);
});

test('the build frame says its add-and-drop lines each use an add; an old Yahoo copy says its adds and waiver wait are not known (#1056)', async ({ page }) => {
  await seedLeague(page);
  await page.goto('/sources/');
  await as(page, { switchOn: true, flag: true, owner: true });
  await page.goto('/team/?league=nba');
  const build = page.getByTestId('owner-preview').and(page.locator('[data-call="build"]'));
  await expect(build.getByTestId('preview-adds-limit')).toContainText(
    '3 of 4 adds left this week: 1 made since your first import this week; any made before it are not seen. Each add-and-drop line below uses one, so make no more than 3 of them. Check the adds you have left on Yahoo before a move below.',
  );
  await expect(build.getByTestId('preview-adds-limit')).toContainText('A player dropped in the last 2 days is on waivers');
  // with none left, the lines wait until Monday, and the frame says so
  await seedLeague(page, { addsUsed: 4 });
  await page.reload();
  await expect(build.getByTestId('preview-adds-limit')).toContainText("0 of 4 adds left this week: 4 used: 4 by Yahoo's count at your last import. The add-and-drop lines below wait until Monday.");
  // the lineup frame says the adds too: none left, so the open slots stay open
  const lineup = page.getByTestId('owner-preview').and(page.locator('[data-call="lineup"]'));
  await expect(lineup.getByTestId('preview-adds-limit')).toContainText("0 of 4 adds left this week: 4 used: 4 by Yahoo's count at your last import. The open slots below stay open until Monday.");
  // state 1: an old Yahoo copy, nothing typed: not known, never "no limit"
  await seedLeague(page, { settingsRead: false });
  for (const path of ['/team/?league=nba', '/streamers/?league=nba']) {
    await page.goto(path);
    const limits = page.getByTestId('preview-adds-limit');
    await expect(limits.first(), path).toBeVisible();
    for (const line of await limits.all()) {
      await expect(line, path).toContainText("This league's adds a week is not known here");
      await expect(line, path).toContainText('The waiver wait is not known here either');
      await expect(line, path).not.toContainText('no weekly limit');
    }
  }
  // state 2: the same old copy with 4 adds and 2 days typed on the League page: known, and said
  await seedLeague(page, { settingsRead: false, typed: true });
  for (const path of ['/team/?league=nba', '/streamers/?league=nba']) {
    await page.goto(path);
    const limits = page.getByTestId('preview-adds-limit');
    await expect(limits.first(), path).toBeVisible();
    for (const line of await limits.all()) {
      await expect(line, path).toContainText('3 of 4 adds left this week');
      await expect(line, path).toContainText('A player dropped in the last 2 days is on waivers');
      await expect(line, path).not.toContainText('not known');
    }
  }
  // state 3: a copy whose import read the settings page: known
  await seedLeague(page);
  await page.goto('/team/?league=nba');
  await expect(page.getByTestId('preview-adds-limit').first()).toBeVisible();
  for (const line of await page.getByTestId('preview-adds-limit').all()) await expect(line).not.toContainText('not known');
});

// the frames say the week's adds in the Today card's own words, whatever the count's source (#1056, #1065)
const COUNTS: { name: string; seed: Seed; line: string | null }[] = [
  { name: "Yahoo's own count", seed: { addsUsed: 1 }, line: "3 of 4 adds left this week: 1 used: 1 by Yahoo's count at your last import" },
  { name: 'counted here since the first import', seed: {}, line: '3 of 4 adds left this week: 1 made since your first import this week; any made before it are not seen' },
  { name: 'no import this week', seed: { week: false }, line: '4 of 4 adds left this week: no import yet this week, so none are counted' },
  {
    name: 'limits typed by hand, nothing counted',
    seed: { settingsRead: false, typed: true, week: false },
    line: '4 of 4 adds left this week: no import yet this week, so none are counted',
  },
  { name: 'an old Yahoo copy, the limit not known', seed: { settingsRead: false, week: false }, line: null },
];

for (const c of COUNTS) {
  test(`the preview's adds line is the Today card's, word for word: ${c.name} (#1056)`, async ({ page }) => {
    await seedLeague(page, c.seed);
    await page.goto('/sources/');
    await as(page, { switchOn: true, flag: true, owner: true });
    await page.goto('/team/?league=nba');
    // the public card, as everyone sees it
    await expect(page.getByTestId('today-open')).toBeVisible();
    const tile = page.getByTestId('today-adds-left');
    const limits = page.getByTestId('preview-adds-limit');
    await expect(limits).toHaveCount(4); // stream, lineup, swaps, build
    if (c.line === null) {
      // the card says nothing of a limit it does not know; the frames say it is not known, and to check
      await expect(tile).toHaveCount(0);
      for (const l of await limits.all()) {
        await expect(l).toContainText("This league's adds a week is not known here");
        await expect(l).toContainText('check the adds you have left on Yahoo before a move below');
        await expect(l.getByTestId('preview-adds-line')).toHaveCount(0);
      }
      return;
    }
    await expect(tile).toHaveText(`(${c.line})`);
    const said = (await tile.textContent())!.trim().replace(/^\(|\)$/g, '');
    const check = 'Check the adds you have left on Yahoo before a move below.';
    for (const l of await limits.all()) {
      await expect(l.getByTestId('preview-adds-line')).toHaveText(said);
      // a count that is not Yahoo's own can be short of what he has made: he is told to check
      if (c.seed.addsUsed) await expect(l).not.toContainText(check);
      else await expect(l).toContainText(check);
    }
    // Pickups' frame says the same, for the same league
    await page.goto('/streamers/?league=nba');
    const top = page.getByTestId('owner-preview').and(page.locator('[data-call="top-adds"]'));
    await expect(top.getByTestId('preview-adds-line')).toHaveText(said);
  });
}

test('the too-close call is logged once, as it settles, when the schedule comes late (#1056)', async ({ page }) => {
  await seedLeague(page);
  await page.goto('/sources/');
  const settled = new Log();
  await as(page, { switchOn: true, flag: true, owner: true }, settled);
  await page.goto('/team/?league=nba');
  await expect.poll(() => settled.posted.filter((e) => e['call'] === 'too-close').length, LOGGED).toBe(1);
  const late = new Log();
  await as(page, { switchOn: true, flag: true, owner: true }, late);
  // the week is drawn first without the lineup plan, then again once the schedule is in
  await page.route('**/schedule/nba.json', async (r) => {
    await new Promise((done) => setTimeout(done, 1000));
    return r.fallback();
  });
  await page.goto('/team/?league=nba');
  await expect(page.getByTestId('owner-preview').getByTestId('lineup-plan')).toBeVisible();
  await page.waitForTimeout(2500);
  const closeCalls = late.posted.filter((e) => e['call'] === 'too-close');
  expect(closeCalls).toHaveLength(1);
  expect(closeCalls[0]!['value']).toBe(settled.posted.find((e) => e['call'] === 'too-close')!['value']);
});

/** The frames' contents a call shows: none of them may be on screen before the log holds the call. */
const CONTENT = ['matchup', 'matchup-streams', 'lineup-plan', 'upgrades', 'build-plan', 'top-adds'];

async function noneShown(page: Page): Promise<void> {
  for (const id of CONTENT) await baseExpect(page.getByTestId('owner-preview').getByTestId(id), id).toHaveCount(0, { timeout: 1 });
}

test('a frame shows nothing until the log holds its calls: it says they are being logged, and a page left before then stores nothing (#1056)', async ({ page }) => {
  await seedLeague(page);
  await page.goto('/sources/');
  const log = new Log();
  await as(page, { switchOn: true, flag: true, owner: true }, log);
  for (const leaveAt of [200, 1000]) {
    await page.goto('/team/?league=nba');
    await expect(page.getByTestId('preview-logging').first()).toBeVisible();
    await page.waitForTimeout(leaveAt);
    await noneShown(page);
    await page.goto('/sources/');
  }
  // left before the request was sent: nothing went to the log, and nothing was shown
  expect(log.batches).toHaveLength(0);
  expect(log.posted).toHaveLength(0);
  // left after it was sent, before the answer: the Worker stores what it received, and the frames would have shown it
  log.delay = 3000;
  await page.goto('/team/?league=nba');
  await expect.poll(() => log.batches.length).toBe(1);
  await noneShown(page);
  await expect(page.getByTestId('preview-logging').first()).toBeVisible();
  await page.goto('/sources/');
  expect(log.posted.length).toBe(log.batches[0]!.calls.length);
  // left at 3 seconds, answered at once: whatever was on screen is in the log
  const later = new Log();
  await as(page, { switchOn: true, flag: true, owner: true }, later);
  await page.goto('/team/?league=nba');
  await page.waitForTimeout(3000);
  const onScreen = await page.getByTestId('owner-preview').evaluateAll((els) =>
    els.filter((e) => e.textContent?.includes('each one shown is logged.')).map((e) => e.getAttribute('data-call')),
  );
  await page.goto('/sources/');
  for (const call of onScreen) expect(later.posted.some((e) => e['call'] === call), call ?? '').toBe(true);
});

for (const answer of [400, 500, 503, 'abort'] as const) {
  test(`a batch the log answers ${answer} is not shown, says so, and is sent again on the next view (#1056)`, async ({ page }) => {
    await seedLeague(page);
    await page.goto('/sources/');
    const log = new Log();
    log.answer = answer;
    await as(page, { switchOn: true, flag: true, owner: true }, log);
    await page.goto('/team/?league=nba');
    const lineup = page.getByTestId('owner-preview').and(page.locator('[data-call="lineup"]'));
    await expect(lineup.getByTestId('preview-not-logged')).toHaveText('This call could not be logged, so it is not shown: it is tried again the next time this page opens.');
    await expect(page.getByTestId('owner-preview').and(page.locator('[data-call="build"]')).getByTestId('preview-not-logged')).toContainText(
      /^\d+ of these \d+ calls could not be logged, so none is shown: they are tried again the next time this page opens\.$/,
    );
    await expect(lineup).not.toContainText('each one shown is logged');
    await noneShown(page);
    // not tried again on this view
    await page.waitForTimeout(3000);
    expect(log.batches).toHaveLength(1);
    // the next view tries again, and shows what the log then holds
    log.answer = 'worker';
    await page.reload();
    await expect(lineup.getByTestId('lineup-plan')).toBeVisible();
    await expect(lineup).toContainText('each one shown is logged.');
    expect(log.batches).toHaveLength(2);
  });
}

test('a second view, and a second tab, store nothing more: the log keeps one entry a call (#1056)', async ({ page, context }) => {
  await seedLeague(page);
  await page.goto('/sources/');
  const log = new Log();
  await as(page, { switchOn: true, flag: true, owner: true }, log);
  await page.goto('/team/?league=nba');
  await expect(page.getByTestId('owner-preview').getByTestId('lineup-plan')).toBeVisible();
  const once = log.posted.length;
  expect(once).toBeGreaterThan(5);
  // the page again: every call answered as held, every frame shown, nothing stored
  await page.reload();
  await expect(page.getByTestId('owner-preview').getByTestId('lineup-plan')).toBeVisible();
  expect(log.batches).toHaveLength(2);
  expect(log.posted).toHaveLength(once);
  // two tabs at once, on the same log
  const other = await context.newPage();
  await other.goto('/sources/');
  await as(other, { switchOn: true, flag: true, owner: true }, log);
  await Promise.all([page.reload(), other.goto('/team/?league=nba')]);
  for (const tab of [page, other]) await expect(tab.getByTestId('owner-preview').getByTestId('lineup-plan')).toBeVisible();
  expect(log.posted).toHaveLength(once);
  await other.close();
});
