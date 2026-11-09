/**
 * One set of league settings (#936 rule 3, #938): every page values players under the league's
 * settings and the punts set on the League page, and a trade partner under their own build.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

type Row = { player_id: string; full_name: string; team_abbreviation: string; position: string; [k: string]: unknown };

const label = (p: Row) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
const PUNTS = ['PTS', 'AST', '3PM'];

async function punt(page: Page, league: 'nba' | 'wnba'): Promise<void> {
  await page.goto(`/league/?league=${league}`);
  for (const c of PUNTS) await page.getByLabel(`Punt ${c}`).check({ force: true });
}

test("the player page values the player under the league's punts, as Rankings does (#938)", async ({ page }) => {
  await page.goto('/p/wnba/1628932/');
  await expect(page.getByTestId('outlook-league')).toContainText('Values are for the default league');
  const defaultValue = await page.getByTestId('player-outlook').locator('dd').nth(1).innerText();
  await punt(page, 'wnba');
  // Rankings' value for the player under the punts
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as Row[];
  await page.goto('/');
  await page.getByPlaceholder('Search player').fill(board.find((r) => r.player_id === '1628932')!.full_name);
  const row = page.getByTestId('board').locator('tbody tr[data-player="1628932"]');
  await page.getByRole('radio', { name: 'Per game' }).click();
  const boardValue = (await row.getByTestId('value').innerText()).trim();

  await page.goto('/p/wnba/1628932/');
  await expect(page.getByTestId('outlook-league')).toHaveText('Values are for your league (10 teams × 10, punting PTS, AST, 3PM), the same as on Rankings.');
  await expect(page.getByTestId('league-rank')).toHaveText(/^#\d+$/);
  const perGame = (await page.getByTestId('player-outlook').locator('dd').nth(1).innerText()).trim();
  expect(perGame).not.toBe(defaultValue);
  expect(Number(perGame)).toBeCloseTo(Number(boardValue), 1);
  // the punted categories are struck and left out of the total
  const cats = page.getByTestId('categories');
  await expect(cats.locator('li[data-punted]')).toHaveCount(3);
  await expect(cats).toContainText('Total, your 6');
  const kept = await cats.locator('li[data-cat]:not([data-punted])').evaluateAll((lis) => lis.map((li) => Number(li.querySelector('.font-medium')?.textContent?.replace('+', '') ?? 0)));
  expect(Number((await page.getByTestId('categories-total').innerText()).replace('+', ''))).toBeCloseTo(kept.reduce((s, v) => s + v, 0), 1);
  await expect(page.getByTestId('punt-chip')).toHaveText('Your league: punting PTS, AST, 3PM · Edit on League');
});

test("Pickups never lists a punted category among the ones you need, even from a link (#938)", async ({ page }) => {
  await punt(page, 'wnba');
  await page.goto('/streamers/?need=z_points,z_steals');
  const needs = page.getByTestId('needs');
  await expect(needs).toBeVisible();
  for (const c of PUNTS) await expect(page.getByLabel(`Need ${c}`)).toHaveCount(0);
  await expect(page.getByLabel('Need STL')).toBeChecked();
  await expect(needs.getByRole('checkbox')).toHaveCount(6);
  await expect(page.getByTestId('punt-chip')).toContainText('Your league: punting PTS, AST, 3PM');
  // the table ranks by the kept need alone
  await expect(page.getByTestId('trending').locator('th[aria-sort="descending"]')).toContainText('Need fit');
});

test("the Trade page values the partner's side under the partner's own build, every category the league scores (#938)", async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as Row[];
  // the partner's best scorer, for a manager's big who adds no scoring
  const byPoints = [...board.slice(0, 30)].sort((a, b) => ((b['z_points'] as number) ?? 0) - ((a['z_points'] as number) ?? 0));
  const scorer = byPoints[0]!;
  const big = byPoints.at(-1)!;
  const rest = board.slice(0, 30).filter((r) => r !== scorer && r !== big);
  await punt(page, 'wnba');
  await page.getByLabel('Format').selectOption('h2h');
  await page.getByLabel('Roster spots').fill('4');
  const rosters = [[big, ...rest.slice(0, 3)], [scorer, ...rest.slice(3, 6)], rest.slice(6, 10)];
  for (const [i, roster] of rosters.entries()) {
    for (const p of roster) await page.getByLabel(`Add a player to Team ${i + 1}`, { exact: true }).fill(label(p));
  }
  await page.goto('/trade/');
  await page.getByTestId('roster-give').getByRole('checkbox', { name: big.full_name }).check();
  await page.getByTestId('roster-get').getByRole('checkbox', { name: scorer.full_name }).check();
  const partner = page.getByTestId('trade-partner');
  await expect(partner).toContainText('For Team 2');
  await expect(page.getByTestId('trade-partner-build')).toHaveText(
    "Team 2's side is valued on all 9 categories your league scores: FantasyScout keeps no punts but yours, and guesses none from a roster.",
  );
  // giving up its best scorer costs the partner points, which the manager's punts no longer hide
  await expect(partner).toContainText('↓');
  await expect(partner).toContainText('PTS');
  await expect(page.getByTestId('trade-both-sides').locator('tr', { hasText: 'Categories down' }).locator('td').last()).toContainText('PTS');
  // the manager's side keeps the manager's build: six categories, no punted one moves
  await expect(page.getByTestId('trade-category-verdict')).toContainText('of your 6 categories');
  await expect(page.getByTestId('trade-both-sides').locator('tr', { hasText: 'Categories up' }).locator('td').nth(1)).not.toContainText('PTS');
});
