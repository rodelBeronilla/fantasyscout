import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { expectNoSidewaysScroll } from './viewport';

// forty characters each, invented
const NAMES = [
  'The Extraordinarily Long Team Name Club!',
  'Second Team With a Very Long Name Indeed',
  'Third Team Whose Name Goes On and On Too',
  'Fourth Team Named at Great Length Always',
  'Fifth Team With Forty Characters Exactly',
  'Sixth Team That Also Has a Long Long Nam',
  'Seventh Team of the League, Named Longly',
  'Eighth and Last Team, With a Long Name!!',
];

async function seedLeague(page: Page) {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { player_id: string }[];
  const teams = 8;
  const rosters = Array.from({ length: teams }, (_, t) => Array.from({ length: 13 }, (_, k) => board[(t + teams * k) % board.length]!.player_id));
  const total = (k: number) => ({
    totals: { z_points: 400 + 10 * k, z_rebounds_total: 200 + k, z_assists: 100 + k, z_steals: 30 + k, z_blocks: 20 + k, z_three_pointers_made: 50 + k, z_turnovers: 60 + k },
    shots: { z_field_goal_pct: [200 + k, 420], z_free_throw_pct: [90 + k, 120] },
  });
  const weeks = [1, 2, 3, 4, 5, 6].map((week) => ({ week, final: week < 6, teams: rosters.map((_, i) => total(week <= 2 ? i : 7 - i)) }));
  const copy = {
    version: 10, teams, rosterSpots: 13, scoring: 'cats9', format: 'h2h', punts: [], names: NAMES,
    rosters, mine: 0, il: [], drafting: false, picks: [], opponent: 1,
    lineup: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 3 }, ilSlots: 2, addsPerWeek: 4, waiverDays: 2,
    source: { host: 'yahoo', leagueId: '99', syncedAt: Date.now() - 3_600_000, rosters, changes: null, opponents: [1, 0, 3, 2, 5, 4, 7, 6], scores: rosters.map((_, i) => total(i)), weeks },
  };
  await page.addInitScript((stored) => localStorage.setItem('fantasyscout:league:nba', stored), JSON.stringify(copy));
}

const PAGES: { name: string; path: string; drawn: (page: Page) => Promise<void> }[] = [
  { name: 'My Team', path: '/team/?league=nba', drawn: (p) => expect(p.getByTestId('matchup-table')).toBeVisible() },
  { name: 'Trade', path: '/trade/?league=nba', drawn: (p) => expect(p.getByTestId('trade-tabs')).toBeVisible() },
  { name: 'League', path: '/league/?league=nba', drawn: (p) => expect(p.getByTestId('weeks-row')).toHaveCount(8) },
];

for (const width of [390, 768]) {
  for (const { name, path, drawn } of PAGES) {
    test(`${name} with forty-character team names does not scroll sideways at ${width} px (#1076)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await seedLeague(page);
      await page.goto(path);
      await drawn(page);
      await page.waitForLoadState('networkidle');
      await expectNoSidewaysScroll(page, name);
    });
  }
}

for (const width of [360, 390, 430, 768, 1024]) {
  test(`the Behind the data menu stays on screen at ${width} px, closed and open (#1076)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const group = page.getByTestId('nav-behind-the-data');
    await expect(group).toBeVisible();
    await expectNoSidewaysScroll(page, 'closed');
    await group.locator('summary').click();
    const menu = group.locator('ul');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await expectNoSidewaysScroll(page, 'open');
  });
}

test('a forty-character name is cut, never dropped: the selects and the folded cards keep it whole (#1076)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedLeague(page);
  await page.goto('/team/?league=nba');
  const opponent = page.getByLabel("This week's opponent");
  await expect(opponent).toHaveAttribute('title', NAMES[1]!);
  await expect(opponent.locator('option', { hasText: NAMES[1]! })).toHaveText(NAMES[1]!);
  await page.goto('/trade/?league=nba');
  const partner = page.getByLabel('Trade partner');
  await expect(partner).toHaveAttribute('title', NAMES[1]!);
  await page.goto('/league/?league=nba');
  const folded = page.getByTestId('team-card-folded').first();
  await expect(folded.locator('span').first()).toHaveAttribute('title', NAMES[1]!);
  await expect(folded).toHaveAccessibleName(`Show ${NAMES[1]}'s roster`);
});
