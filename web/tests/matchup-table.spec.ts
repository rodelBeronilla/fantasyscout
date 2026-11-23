import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { expectNoSidewaysScroll } from './viewport';

const PHONE = 390;

/** An invented eight-team, thirteen-spot league with the score so far from Yahoo; the opponent's name as given. */
async function seedLeague(page: Page, opponent: string) {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { player_id: string }[];
  const teams = 8;
  const rosters = Array.from({ length: teams }, (_, t) => Array.from({ length: 13 }, (_, k) => board[(t + teams * k) % board.length]!.player_id));
  const total = (k: number) => ({
    totals: { z_points: 400 + 10 * k, z_rebounds_total: 200 + k, z_assists: 100 + k, z_steals: 30 + k, z_blocks: 20 + k, z_three_pointers_made: 50 + k, z_turnovers: 60 + k },
    shots: { z_field_goal_pct: [200 + k, 420], z_free_throw_pct: [90 + k, 120] },
  });
  const copy = {
    version: 10, teams, rosterSpots: 13, scoring: 'cats9', format: 'h2h', punts: [],
    names: ['Corner Threes', opponent, 'Glass Cleaners', 'Fast Breakers', 'Bench Mob', 'Pick and Roll', 'Zone Busters', 'Second Unit'],
    rosters, mine: 0, il: [], drafting: false, picks: [], opponent: 1,
    lineup: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, UTIL: 3 }, ilSlots: 2, addsPerWeek: 4, waiverDays: 2,
    source: { host: 'yahoo', leagueId: '99', syncedAt: Date.now() - 3_600_000, rosters, changes: null, opponents: [1, 0, 3, 2, 5, 4, 7, 6], scores: rosters.map((_, i) => total(i)) },
  };
  await page.addInitScript((stored) => localStorage.setItem('fantasyscout:league:nba', stored), JSON.stringify(copy));
}

// 23 and 40 characters, invented
for (const opponent of ['The Late Night Scratch!', 'The Extraordinarily Long Team Name Club!']) {
  test(`on a phone every matchup column says whose and when at every scroll position, with a ${opponent.length}-character opponent (#1113)`, async ({ page }) => {
    await page.setViewportSize({ width: PHONE, height: 844 });
    await seedLeague(page, opponent);
    await page.goto('/team/?league=nba');
    const table = page.getByTestId('matchup-table');
    await expect(table.getByTestId('matchup-row')).toHaveCount(9);
    const region = page.locator('.table-scroll', { has: table });
    const max = await region.evaluate((el) => el.scrollWidth - el.clientWidth);
    for (let x = 0; x <= max + 10; x += 10) {
      await region.evaluate((el, left) => el.scrollTo({ left }), x);
      // for each column with a number fully in view (right of the pinned category), its heading's two
      // lines are fully in view above it and say whose the numbers are and whether so far or projected
      const unread = await table.evaluate((t) => {
        const box = t.closest('.table-scroll')!.getBoundingClientRect();
        const pin = t.querySelector('thead th')!.getBoundingClientRect().right;
        const seen = (r: DOMRect) => r.left >= pin - 0.5 && r.right <= box.right + 0.5;
        const heads = [...t.querySelectorAll('thead th')];
        const out: string[] = [];
        t.querySelectorAll('tbody tr').forEach((tr) => {
          [...tr.children].forEach((cell, i) => {
            if (i === 0 || !/\d/.test(cell.textContent ?? '')) return;
            const range = document.createRange();
            range.selectNodeContents(cell);
            if (!seen(range.getBoundingClientRect())) return;
            const head = heads[i]!;
            const lines = [...head.querySelectorAll('span')];
            const says = /^(You|Them|Edge)(so far|projected)$/.test(lines.map((l) => l.textContent).join(''));
            const inView = lines.length === 2 && lines.every((l) => seen(l.getBoundingClientRect()));
            if (!says || !inView) out.push(`column ${i} "${head.textContent}" at scroll ${Math.round(t.closest('.table-scroll')!.scrollLeft)}`);
          });
        });
        return [...new Set(out)];
      });
      expect(unread).toEqual([]);
    }
    // the opponent is named once beside the table, whole, wrapping on a phone; the headings say "Them"
    await expect(table.locator('thead')).not.toContainText(opponent);
    await expect(page.getByTestId('matchup-them')).toHaveText(`Them: ${opponent}`);
    const them = await page.getByTestId('matchup-them').boundingBox();
    expect(them!.x + them!.width).toBeLessThanOrEqual(PHONE);
    // the categories head their rows for a screen reader
    await expect(table.getByRole('rowheader')).toHaveCount(9);
    await expect(table.getByRole('rowheader').first()).toHaveText(/^PTS/);
    await expectNoSidewaysScroll(page);
  });
}
