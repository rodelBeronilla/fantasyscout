import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

import { expectNoSidewaysScroll } from './viewport';

const PHONE = 390;

test('the sideways-scroll check fails on a page 1 px too wide, under phone emulation too (#1112)', async ({ page }) => {
  await page.setViewportSize({ width: PHONE, height: 844 });
  await page.goto('/health/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  // a block one pixel wider than the phone
  await page.evaluate((w) => {
    const wide = document.createElement('div');
    wide.style.width = `${w + 1}px`;
    wide.style.height = '1px';
    document.body.append(wide);
  }, PHONE);
  await expect(expectNoSidewaysScroll(page)).rejects.toThrow(`the document is ${PHONE + 1} px wide at a ${PHONE} px viewport`);
});

/** An invented league of the owner's shape: eight teams, thirteen spots, the score so far, five finished weeks and a sixth under way. */
async function seedLeague(page: Page) {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { player_id: string }[];
  const teams = 8;
  const rosters = Array.from({ length: teams }, (_, t) => Array.from({ length: 13 }, (_, k) => board[(t + teams * k) % board.length]!.player_id));
  const total = (k: number) => ({
    totals: { z_points: 400 + 10 * k, z_rebounds_total: 200 + k, z_assists: 100 + k, z_steals: 30 + k, z_blocks: 20 + k, z_three_pointers_made: 50 + k, z_turnovers: 60 + k },
    shots: { z_field_goal_pct: [200 + k, 420], z_free_throw_pct: [90 + k, 120] },
  });
  // the order turns over after week 2, so the Season view has arrows in every column
  const weeks = [1, 2, 3, 4, 5, 6].map((week) => ({ week, final: week < 6, teams: rosters.map((_, i) => total(week <= 2 ? i : 7 - i)) }));
  const copy = {
    version: 10, teams, rosterSpots: 13, scoring: 'cats9', format: 'h2h', punts: [],
    names: ['Corner Threes', 'The Late Scratches', 'Glass Cleaners', 'Fast Breakers', 'Bench Mob', 'Pick and Roll', 'Zone Busters', 'Second Unit'],
    rosters, mine: 0, il: [], drafting: false, picks: [], opponent: 1,
    lineup: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 3 }, ilSlots: 2, addsPerWeek: 4, waiverDays: 2,
    source: {
      host: 'yahoo', leagueId: '99', syncedAt: Date.now() - 3_600_000, rosters, changes: null,
      opponents: [1, 0, 3, 2, 5, 4, 7, 6], scores: rosters.map((_, i) => total(i)), weeks,
    },
  };
  await page.addInitScript((stored) => localStorage.setItem('fantasyscout:league:nba', stored), JSON.stringify(copy));
}

// each page with the league, measured once it is drawn
const LEAGUE_PAGES: { name: string; path: string; drawn: (page: Page) => Promise<void> }[] = [
  { name: 'My Team', path: '/team/?league=nba', drawn: (p) => expect(p.getByTestId('matchup-table')).toBeVisible() },
  { name: 'Streamers', path: '/streamers/?league=nba', drawn: (p) => expect(p.getByTestId('trending').locator('tbody tr').first()).toBeVisible() },
  { name: 'Trade', path: '/trade/?league=nba', drawn: (p) => expect(p.getByTestId('trade-tabs')).toBeVisible() },
  { name: 'League, a week', path: '/league/?league=nba', drawn: (p) => expect(p.getByTestId('weeks-row')).toHaveCount(8) },
  {
    name: 'League, Season',
    path: '/league/?league=nba',
    drawn: async (p) => {
      await expect(p.getByTestId('weeks-row')).toHaveCount(8);
      await p.getByTestId('league-weeks').getByRole('button', { name: 'Season' }).click();
      await expect(p.getByTestId('league-weeks').getByText('The average rank over the 5 finished weeks')).toBeVisible();
    },
  },
  { name: 'Rankings', path: '/?league=nba', drawn: (p) => expect(p.getByTestId('board').locator('tbody tr').first()).toBeVisible() },
];

for (const { name, path, drawn } of LEAGUE_PAGES) {
  test(`${name} with an eight-team, thirteen-spot league does not scroll sideways at ${PHONE} px (#1112)`, async ({ page }) => {
    await page.setViewportSize({ width: PHONE, height: 844 });
    await seedLeague(page);
    await page.goto(path);
    await drawn(page);
    await page.waitForLoadState('networkidle');
    await expectNoSidewaysScroll(page, name);
  });
}

// every page in the sitemap, with no league saved, on the phone project (the owner's phone); the
// sitemap is the one the build wrote, read when the tests are collected
const SITEMAP = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'sitemap.xml');
const PAGES = existsSync(SITEMAP) ? [...readFileSync(SITEMAP, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname) : [];
test.describe('every page in the sitemap', () => {
  test.skip(({ isMobile }) => !isMobile, 'the phone project only');
  test('the sitemap lists the pages', () => expect(PAGES.length).toBeGreaterThan(10));
  for (const path of PAGES) {
    test(`${path} fits ${PHONE} px with no league saved (#1112)`, async ({ page }) => {
      await page.setViewportSize({ width: PHONE, height: 844 });
      await page.goto(path);
      await page.locator('main h1').first().waitFor();
      await page.waitForLoadState('networkidle');
      await expectNoSidewaysScroll(page);
    });
  }
});
