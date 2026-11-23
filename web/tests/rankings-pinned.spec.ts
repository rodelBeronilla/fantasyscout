import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { expectNoSidewaysScroll } from './viewport';

const PHONE = 390;

/** An invented eight-team, thirteen-spot league, so the board's rows carry the owner tags too. */
async function seedLeague(page: Page) {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { player_id: string }[];
  const teams = 8;
  const rosters = Array.from({ length: teams }, (_, t) => Array.from({ length: 13 }, (_, k) => board[(t + teams * k) % board.length]!.player_id));
  const copy = {
    version: 10, teams, rosterSpots: 13, scoring: 'cats9', format: 'h2h', punts: [],
    names: ['Corner Threes', 'The Late Night Scratch!', 'Glass Cleaners', 'Fast Breakers', 'Bench Mob', 'Pick and Roll', 'Zone Busters', 'Second Unit'],
    rosters, mine: 0, il: [], drafting: false, picks: [], opponent: 1,
    lineup: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 3 }, ilSlots: 2, addsPerWeek: 4, waiverDays: 2,
    source: { host: 'yahoo', leagueId: '99', syncedAt: Date.now() - 3_600_000, rosters, changes: null, opponents: [1, 0, 3, 2, 5, 4, 7, 6] },
  };
  await page.addInitScript((stored) => localStorage.setItem('fantasyscout:league:nba', stored), JSON.stringify(copy));
}

for (const [what, path, seed] of [
  ['the WNBA board with no league saved', '/', false],
  ['the NBA board with an eight-team league', '/?league=nba', true],
] as const) {
  test(`on a phone the board's pinned columns take at most half the table, and the player's name reads: ${what} (#1114)`, async ({ page }) => {
    await page.setViewportSize({ width: PHONE, height: 844 });
    if (seed) await seedLeague(page);
    await page.goto(path);
    const board = page.getByTestId('board');
    await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
    const region = page.locator('.table-scroll', { has: board });
    const box = (await region.boundingBox())!;
    // the rank and the player, pinned, measured on the header and on every row
    const pinned = await board.evaluate((t) => Math.max(...[...t.querySelectorAll('.pin-second')].map((c) => c.getBoundingClientRect().right)));
    expect(pinned - box.x, `pinned ${Math.round(pinned - box.x)} of ${Math.round(box.width)} px`).toBeLessThanOrEqual(box.width / 2);
    // each player's name shows at least a readable part, and its whole text is kept for a cut one
    const names = await board.locator('tbody tr[data-player] .pin-second a[href*="/p/"]').evaluateAll((links) =>
      links.slice(0, 40).map((a) => ({ text: a.textContent ?? '', shown: a.getBoundingClientRect().width, need: a.scrollWidth, cut: a.scrollWidth > a.clientWidth + 1, title: a.getAttribute('title') ?? '' })),
    );
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) {
      expect(n.shown, n.text).toBeGreaterThanOrEqual(Math.min(n.need, 60));
      if (n.cut) expect(n.title, n.text).toBe(n.text);
    }
    await expectNoSidewaysScroll(page);
  });
}
