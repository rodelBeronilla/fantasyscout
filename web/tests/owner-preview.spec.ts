/**
 * The owner preview (#1056): the calls a switch hides show to the signed-in owner alone, with his
 * preview on, each under "Preview: not validated" and each logged once. The bar: for everyone
 * else, and for the owner with the preview off, the page is the same, byte for byte.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

type Row = { player_id: string };

// the fixture's NBA data is as of 2026-10-31; a Monday two days later, mid-afternoon Eastern
const NOW = new Date('2026-11-02T16:00:00Z');

/** A made-up eight-team Yahoo head-to-head league, as the import keeps it, ten players a team. */
async function seedLeague(page: Page): Promise<{ rosters: string[][] }> {
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
      week: { monday: '2026-11-02', roster: rosters[0]!.slice(1) },
    },
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

/** Sets who this browser is, for the next page load. */
async function as(page: Page, who: Who, posted: Record<string, unknown>[] = []): Promise<void> {
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
  await page.route('**/api/owner/log', (r) => {
    if (r.request().method() === 'POST') posted.push(r.request().postDataJSON() as Record<string, unknown>);
    return r.fulfill({ json: { ok: true } });
  });
}

/** The page's main content once it has settled. */
async function mainHtml(page: Page, path: string, ready: string): Promise<string> {
  await page.goto(path);
  await expect(page.getByTestId(ready).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  return page.locator('main').innerHTML();
}

const PAGES: { name: string; path: (rosters: string[][]) => string; ready: string; calls: string[] }[] = [
  { name: 'My Team', path: () => '/team/?league=nba', ready: 'my-roster', calls: ['too-close'] },
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
    const posted: Record<string, unknown>[] = [];
    await page.goto('/sources/');
    await as(page, { switchOn: true, flag: true, owner: true }, posted);
    await page.goto(p.path(rosters));
    const frames = page.getByTestId('owner-preview');
    for (const call of p.calls) {
      const frame = frames.and(page.locator(`[data-call="${call}"]`));
      await expect(frame, call).toBeVisible();
      await expect(frame.getByRole('heading', { name: /^Preview: not validated/ }), call).toBeVisible();
      await expect(frame, call).toContainText('Shown to you alone. This call has not passed its check (see Methodology); each one shown is logged.');
    }
    await page.waitForLoadState('networkidle');
    const logged = posted.filter((e) => e['kind'] === 'call').map((e) => e['call']);
    for (const call of p.calls) expect(logged.filter((c) => c === call), call).toHaveLength(1);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      const found = await new AxeBuilder({ page }).include('[data-testid="owner-preview"]').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(found.violations, theme).toEqual([]);
    }
  });
}
